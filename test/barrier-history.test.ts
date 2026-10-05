import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommitConflictError, Database, type Transaction } from '../src/mvcc.js';
import { reconcileBarrierHistory } from '../src/model.js';

/** Deterministic PRNG (mulberry32) so the workload is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TABLES = ['alpha', 'beta', 'gamma'];
const KEYS = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'];

function runRandomizedBarrierWorkload(seed: number, epochs: number): Database {
  const rand = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const db = new Database();
  for (const t of TABLES) db.createTable(t);

  const seedTxn = db.begin();
  for (const t of TABLES) for (const k of KEYS) seedTxn.write(t, k, 0);
  seedTxn.commit();
  db.barrier();

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Each epoch runs a batch of "concurrent" transactions, then a barrier.
    const batch: Transaction[] = [];
    const txnCount = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < txnCount; i++) batch.push(db.begin());

    for (const txn of batch) {
      const ops = 1 + Math.floor(rand() * 5);
      for (let op = 0; op < ops; op++) {
        const table = pick(TABLES);
        const key = pick(KEYS);
        if (rand() < 0.45) {
          txn.read(table, key);
        } else if (rand() < 0.1) {
          txn.delete(table, key);
        } else {
          const cur = txn.read(table, key);
          txn.write(table, key, (typeof cur === 'number' ? cur : 0) + 1);
        }
      }
    }

    for (const txn of batch) {
      if (rand() < 0.1) {
        txn.abort();
        continue;
      }
      try {
        txn.commit();
      } catch (e) {
        assert.ok(e instanceof CommitConflictError, 'only conflict aborts expected');
      }
    }
    db.barrier();
  }
  return db;
}

test('barrier history reconciles with the full version model (randomized, seeded)', () => {
  for (const seed of [1, 7, 42, 1337, 20261005]) {
    const db = runRandomizedBarrierWorkload(seed, 40);
    const violations = reconcileBarrierHistory(db.history, db.versionChains());
    assert.deepEqual(violations, [], `seed ${seed}: ${violations.join('\n')}`);
  }
});

test('scripted barrier history reconciles and conflict evidence is model-checked', () => {
  const db = new Database();
  db.createTable('t');
  const s = db.begin();
  s.write('t', 'x', 1);
  s.commit();
  db.barrier();

  // Epoch 1: two writers race on 'x'; one must lose with valid evidence.
  const t1 = db.begin();
  const t2 = db.begin();
  t1.write('t', 'x', 10);
  t2.write('t', 'x', 20);
  t1.commit();
  db.barrier();
  assert.throws(() => t2.commit(), CommitConflictError);
  db.barrier();

  // Epoch 2: a reader pinned to an old snapshot while the world moves on.
  const reader = db.begin();
  const w = db.begin();
  w.write('t', 'x', 30);
  w.commit();
  assert.equal(reader.read('t', 'x'), 10);
  reader.abort();
  db.barrier();

  const violations = reconcileBarrierHistory(db.history, db.versionChains());
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('reconciler detects a tampered history (sanity check of the checker itself)', () => {
  const db = new Database();
  db.createTable('t');
  const s = db.begin();
  s.write('t', 'x', 1);
  s.commit();
  const reader = db.begin();
  reader.read('t', 'x');

  // Tamper: claim the read returned a different value than the snapshot allows.
  const tampered = db.history.map((ev) =>
    ev.kind === 'read' ? { ...ev, value: 999 } : ev,
  );
  const violations = reconcileBarrierHistory(tampered, db.versionChains());
  assert.ok(violations.length > 0);
  assert.match(violations[0], /read t\(x\)/);
});
