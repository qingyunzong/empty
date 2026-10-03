import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, PlanError, naiveOccupancy } from '../src/store.js';
import { runCommands } from '../cli.js';

// Acceptance 1: capacity 3, place 3 -> ok, one more -> rejected.
test('single txn fills capacity exactly, overflow by 1 rejected', () => {
  const s = new Store();
  s.setCapacity('A', 100, 102, 3);

  // Fill exactly: 3 units across slots [100,102).
  let t = s.begin();
  s.insert(t.txn, { id: 'o1', workcenter: 'A', start: 100, end: 102, qty: 3 });
  const cert = s.commit(t.txn);
  assert.equal(cert.txn, t.txn);
  assert.ok(cert.commitSeq > 0);
  assert.ok(cert.committedAt);

  // Boundary: exactly equal is allowed (used 3/3). One more unit must fail.
  t = s.begin();
  s.read(t.txn, 'A', 100, 102);
  s.insert(t.txn, { id: 'o2', workcenter: 'A', start: 100, end: 101, qty: 1 });
  assert.throws(() => s.commit(t.txn), (e) => e instanceof PlanError && e.code === 'E_CAPACITY');

  // Exactly-equal boundary on a fresh workcenter: 3 into capacity 3 commits.
  s.setCapacity('B', 100, 101, 3);
  t = s.begin();
  s.insert(t.txn, { id: 'o3', workcenter: 'B', start: 100, end: 101, qty: 3 });
  assert.doesNotThrow(() => s.commit(t.txn));

  // Same-txn overflow: insert 3 then 1 more in one txn -> E_CAPACITY.
  s.setCapacity('C', 100, 101, 3);
  t = s.begin();
  s.insert(t.txn, { id: 'o4', workcenter: 'C', start: 100, end: 101, qty: 3 });
  s.insert(t.txn, { id: 'o5', workcenter: 'C', start: 100, end: 101, qty: 1 });
  assert.throws(() => s.commit(t.txn), (e) => e.code === 'E_CAPACITY');
});

// Acceptance 2: two concurrent txns read the same remaining capacity and
// commit different orders whose total exceeds capacity -> one wins, the
// other fails predicate validation. Non-overlapping slots both succeed.
test('concurrent txns: predicate revalidation prevents oversell', () => {
  const s = new Store();
  s.setCapacity('A', 0, 10, 3);
  // Seed: 1 unit already committed on slots [2,4), remaining = 2.
  let t0 = s.begin();
  s.insert(t0.txn, { id: 'seed', workcenter: 'A', start: 2, end: 4, qty: 1 });
  s.commit(t0.txn);

  const tA = s.begin();
  const tB = s.begin();
  // Both observe remaining capacity 2 on slots [2,4).
  const rA = s.read(tA.txn, 'A', 2, 4);
  const rB = s.read(tB.txn, 'A', 2, 4);
  assert.deepEqual(rA.remaining, [2, 2]);
  assert.deepEqual(rB.remaining, [2, 2]);

  // Different orders, each fits alone, together they oversell (1+2+2 > 3).
  s.insert(tA.txn, { id: 'orderA', workcenter: 'A', start: 2, end: 4, qty: 2 });
  s.insert(tB.txn, { id: 'orderB', workcenter: 'A', start: 2, end: 4, qty: 2 });

  const certA = s.commit(tA.txn); // first committer wins
  assert.equal(certA.predicates.length, 1);
  assert.match(certA.predicates[0].hash, /^[0-9a-f]{64}$/);
  assert.throws(() => s.commit(tB.txn), (e) => e.code === 'E_SNAPSHOT');

  // Final occupancy must never exceed capacity.
  assert.deepEqual(s.index.enumerate('A', 2, 4), [3, 3]);

  // Non-overlapping slots: both commit fine.
  const tC = s.begin();
  const tD = s.begin();
  s.read(tC.txn, 'A', 6, 8);
  s.read(tD.txn, 'A', 8, 10);
  s.insert(tC.txn, { id: 'orderC', workcenter: 'A', start: 6, end: 8, qty: 3 });
  s.insert(tD.txn, { id: 'orderD', workcenter: 'A', start: 8, end: 10, qty: 3 });
  assert.doesNotThrow(() => s.commit(tC.txn));
  assert.doesNotThrow(() => s.commit(tD.txn));
});

// Acceptance 3: enumerate <=4 overlapping/adjacent slot operations and
// compare the predicate index against a naive interval-scan reference.
test('index enumeration matches naive interval scan (<=4 ops per case)', () => {
  const ops = [
    { id: 'w1', wc: 'W', start: 0, end: 2, qty: 1 }, // [0,2)
    { id: 'w2', wc: 'W', start: 1, end: 3, qty: 2 }, // overlaps w1 on slot 1
    { id: 'w3', wc: 'W', start: 2, end: 4, qty: 3 }, // adjacent to w1, overlaps w2
    { id: 'w4', wc: 'W', start: 3, end: 5, qty: 1 }, // adjacent to w2, overlaps w3
  ];
  const s = new Store();
  s.setCapacity('W', 0, 8, 100);

  // Commit ops one per txn, verifying index vs naive after each step.
  const committed = [];
  for (const o of ops) {
    const t = s.begin();
    s.insert(t.txn, { id: o.id, workcenter: o.wc, start: o.start, end: o.end, qty: o.qty });
    s.commit(t.txn);
    committed.push({ id: o.id, workcenter: o.wc, start: o.start, end: o.end, qty: o.qty });
    for (let start = 0; start <= 5; start++) {
      for (let end = start + 1; end <= 6; end++) {
        assert.deepEqual(
          s.index.enumerate('W', start, end),
          naiveOccupancy(committed, 'W', start, end),
          `mismatch on [${start},${end}) after ${committed.length} ops`,
        );
      }
    }
  }

  // Adjust + cancel keep the index consistent too.
  let t = s.begin();
  s.adjust(t.txn, 'w2', { qty: 1, end: 4 });
  s.cancel(t.txn, 'w4');
  s.commit(t.txn);
  const after = [
    { id: 'w1', workcenter: 'W', start: 0, end: 2, qty: 1 },
    { id: 'w2', workcenter: 'W', start: 1, end: 4, qty: 1 },
    { id: 'w3', workcenter: 'W', start: 2, end: 4, qty: 3 },
  ];
  for (let start = 0; start <= 5; start++) {
    for (let end = start + 1; end <= 6; end++) {
      assert.deepEqual(
        s.index.enumerate('W', start, end),
        naiveOccupancy(after, 'W', start, end),
        `mismatch on [${start},${end}) after adjust/cancel`,
      );
    }
  }
});

// Certificate contents: txn id, commit timestamp, validated predicate hashes.
test('commit certificate carries txn id, timestamp and predicate hashes', () => {
  const s = new Store();
  s.setCapacity('A', 0, 4, 5);
  const t = s.begin();
  s.read(t.txn, 'A', 0, 2);
  s.read(t.txn, 'A', 2, 4);
  s.insert(t.txn, { id: 'x', workcenter: 'A', start: 0, end: 2, qty: 1 });
  const cert = s.commit(t.txn);
  assert.equal(cert.txn, t.txn);
  assert.ok(!Number.isNaN(Date.parse(cert.committedAt)));
  assert.equal(cert.predicates.length, 2);
  for (const p of cert.predicates) assert.match(p.hash, /^[0-9a-f]{64}$/);
  assert.match(cert.predicatesHash, /^[0-9a-f]{64}$/);
});

// CLI end-to-end: JSON commands in, JSON results out.
test('CLI runCommands handles a full plan with E_CAPACITY result', () => {
  const results = runCommands([
    { op: 'set_capacity', workcenter: 'A', start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:30:00Z', capacity: 3 },
    { op: 'begin' },
    { op: 'insert', txn: 1, order: { id: 'o1', workcenter: 'A', start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:30:00Z', qty: 3 } },
    { op: 'commit', txn: 1 },
    { op: 'begin' },
    { op: 'read', txn: 2, workcenter: 'A', start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:30:00Z' },
    { op: 'insert', txn: 2, order: { id: 'o2', workcenter: 'A', start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:15:00Z', qty: 1 } },
    { op: 'commit', txn: 2 },
  ]);
  assert.equal(results[3].commitSeq, 1);
  assert.deepEqual(results[5].remaining, [0, 0]);
  assert.equal(results[7].error.code, 'E_CAPACITY');
});
