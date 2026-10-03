import test from 'node:test';
import assert from 'node:assert/strict';
import { Database, naiveOccupancy } from '../src/index.js';
import { runPlan } from '../bin/cli.js';

function capacityDb(slots, capacity, workcenter = 'A') {
  const db = new Database();
  for (let slot = 0; slot < slots; slot++) db.setCapacity(workcenter, slot, capacity);
  return db;
}

test('acceptance 1: fill capacity-3 slot with 3 units succeeds, 1 more fails with E_CAPACITY', () => {
  const db = capacityDb(1, 3);

  const t1 = db.begin();
  t1.insert({ order: 'o1', workcenter: 'A', start: 0, end: 1, qty: 3 });
  const r1 = t1.commit();
  assert.equal(r1.ok, true);
  assert.equal(db.slotOccupancy('A', 0), 3); // exactly at capacity: allowed

  const t2 = db.begin();
  assert.equal(t2.readRemaining('A', 0, 1), 0);
  t2.insert({ order: 'o2', workcenter: 'A', start: 0, end: 1, qty: 1 });
  const r2 = t2.commit();
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'E_CAPACITY');
  assert.deepEqual(r2.detail, { workcenter: 'A', slot: 0, load: 4, capacity: 3 });

  // Boundary: exceeding by exactly 1 is rejected; equal stays allowed.
  const t3 = db.begin();
  t3.adjust({ order: 'o1', qty: 4 });
  assert.equal(t3.commit().error, 'E_CAPACITY');
  const t4 = db.begin();
  t4.adjust({ order: 'o1', qty: 3 });
  assert.equal(t4.commit().ok, true);
});

test('acceptance 2: concurrent readers of same remaining capacity, one wins, other gets E_SNAPSHOT', () => {
  const db = capacityDb(2, 3);

  const ta = db.begin();
  const tb = db.begin();
  assert.equal(ta.readRemaining('A', 0, 1), 3);
  assert.equal(tb.readRemaining('A', 0, 1), 3);

  // Different work orders, combined qty 4 > capacity 3.
  ta.insert({ order: 'oa', workcenter: 'A', start: 0, end: 1, qty: 2 });
  tb.insert({ order: 'ob', workcenter: 'A', start: 0, end: 1, qty: 2 });

  const ra = ta.commit();
  assert.equal(ra.ok, true);
  assert.equal(typeof ra.commitTimestamp, 'string');
  assert.equal(ra.predicateHashes.length, 1);
  assert.match(ra.predicateHashes[0], /^[0-9a-f]{64}$/);

  // tb's read predicate no longer matches latest committed state.
  const rb = tb.commit();
  assert.equal(rb.ok, false);
  assert.equal(rb.error, 'E_SNAPSHOT');
  assert.equal(rb.detail.expected, 0); // tb saw occupancy 0
  assert.equal(rb.detail.actual, 2);   // latest committed occupancy is 2

  // Non-overlapping slots commit concurrently without conflict.
  const tc = db.begin();
  const td = db.begin();
  tc.readRemaining('A', 0, 1);
  td.readRemaining('A', 1, 2);
  tc.insert({ order: 'oc', workcenter: 'A', start: 0, end: 1, qty: 1 });
  td.insert({ order: 'od', workcenter: 'A', start: 1, end: 2, qty: 3 });
  assert.equal(tc.commit().ok, true);
  assert.equal(td.commit().ok, true);
  assert.equal(db.slotOccupancy('A', 0), 3);
  assert.equal(db.slotOccupancy('A', 1), 3);
});

test('acceptance 3: enumerated <=4 overlapping/adjacent ops match naive interval scan', () => {
  // Adjacent intervals [0,1) & [1,2), plus [0,2) overlapping both.
  const alphabet = [
    { kind: 'insert', order: 'w1', start: 0, end: 1, qty: 1 },
    { kind: 'insert', order: 'w2', start: 1, end: 2, qty: 1 },
    { kind: 'insert', order: 'w3', start: 0, end: 2, qty: 1 },
    { kind: 'adjust', order: 'w1', qty: 2 },
    { kind: 'adjust', order: 'w2', qty: 2 },
    { kind: 'cancel', order: 'w1' },
    { kind: 'cancel', order: 'w2' },
    { kind: 'cancel', order: 'w3' },
  ];
  const predicates = [
    [0, 1],
    [1, 2],
    [0, 2],
  ];

  const verifyAll = (db, label) => {
    for (let seq = 0; seq <= db.commitSeq; seq++) {
      for (const [start, end] of predicates) {
        const viaIndex = db.index.valueAt('A', start, end, seq);
        const viaNaive = naiveOccupancy(db.versions, seq, 'A', start, end);
        assert.equal(
          viaIndex,
          viaNaive,
          `${label}: predicate A|${start}|${end} at seq ${seq}: index=${viaIndex} naive=${viaNaive}`,
        );
      }
    }
  };

  let sequences = 0;
  const runSequence = (ops) => {
    sequences++;
    const db = capacityDb(3, 100);
    // A snapshot taken before any commit must stay readable afterwards.
    const early = db.begin();
    for (const op of ops) {
      const tx = db.begin();
      tx.readOccupancy('A', 0, 2);
      if (op.kind === 'insert') {
        tx.insert({ order: op.order, workcenter: 'A', start: op.start, end: op.end, qty: op.qty });
      } else if (op.kind === 'adjust') {
        tx.adjust({ order: op.order, qty: op.qty });
      } else {
        tx.cancel({ order: op.order });
      }
      tx.commit(); // may fail with E_ORDER_EXISTS / E_NO_ORDER; state must stay consistent
      verifyAll(db, `ops=${ops.map((o) => `${o.kind}:${o.order}`).join(',')}`);
    }
    // Snapshot isolation: the early transaction still sees the empty state.
    assert.equal(early.readOccupancy('A', 0, 2), 0);
  };

  const enumerate = (prefix, depth) => {
    if (depth === 0) {
      if (prefix.length > 0) runSequence(prefix);
      return;
    }
    for (const op of alphabet) enumerate([...prefix, op], depth - 1);
  };
  for (let length = 1; length <= 4; length++) enumerate([], length);

  assert.equal(sequences, 8 + 64 + 512 + 4096);
});

test('acceptance 4: CLI processes JSON plan and reports E_CAPACITY / E_SNAPSHOT', () => {
  const plan = {
    commands: [
      { op: 'setCapacity', workcenter: 'A', slot: 0, capacity: 3 },
      { op: 'begin', tx: 't1' },
      { op: 'readRemaining', tx: 't1', workcenter: 'A', start: 0, end: 1 },
      { op: 'insert', tx: 't1', order: 'o1', workcenter: 'A', start: 0, end: 1, qty: 2 },
      { op: 'begin', tx: 't2' },
      { op: 'readRemaining', tx: 't2', workcenter: 'A', start: 0, end: 1 },
      { op: 'insert', tx: 't2', order: 'o2', workcenter: 'A', start: 0, end: 1, qty: 2 },
      { op: 'commit', tx: 't1' },
      { op: 'commit', tx: 't2' },
      { op: 'begin', tx: 't3' },
      { op: 'insert', tx: 't3', order: 'o3', workcenter: 'A', start: 0, end: 1, qty: 2 },
      { op: 'commit', tx: 't3' },
    ],
  };
  const results = runPlan(plan);

  const commit1 = results.find((r) => r.op === 'commit' && r.tx === 't1');
  assert.equal(commit1.ok, true);
  assert.equal(commit1.txId, 'tx-1');
  assert.equal(typeof commit1.commitTimestamp, 'string');
  assert.equal(commit1.predicateHashes.length, 1);

  const commit2 = results.find((r) => r.op === 'commit' && r.tx === 't2');
  assert.equal(commit2.ok, false);
  assert.equal(commit2.error, 'E_SNAPSHOT');

  // t3 started after t1 committed: sees occupancy 2, adding 2 exceeds capacity 3.
  const commit3 = results.find((r) => r.op === 'commit' && r.tx === 't3');
  assert.equal(commit3.ok, false);
  assert.equal(commit3.error, 'E_CAPACITY');
});
