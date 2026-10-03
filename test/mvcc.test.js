import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/database.js';
import { createGate } from '../test-utils.js';

test('snapshot reads see begin-of-tx state; freeze validates latest committed', async () => {
  const db = new Database();
  db.setAccount('A', 100);
  const gate = createGate();
  let snapshotAvailable;

  const t1 = db.transaction(async (tx) => {
    await gate.wait('t2committed');
    snapshotAvailable = tx.getAvailable('A'); // MVCC snapshot: still 100
    // Freeze validation uses the latest committed balance (available = 40).
    await assert.rejects(tx.freeze('A', 50), (err) => err.code === 'E_INSUFFICIENT');
    await tx.freeze('A', 40); // exactly the latest committed available: ok
  });

  await db.transaction(async (tx) => {
    await tx.freeze('A', 60);
  });
  gate.signal('t2committed');

  await t1;
  assert.equal(snapshotAvailable, 100, 'snapshot read sees pre-t2 state');
  assert.equal(db.getAccount('A').frozen, 100);
  assert.equal(db.getAccount('A').available, 0);
});

test('multi-account freeze in one transaction is atomic', async () => {
  const db = new Database();
  db.setAccount('A', 100);
  db.setAccount('B', 50);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.freeze('A', 10);
      await tx.freeze('B', 60); // exceeds available -> aborts whole tx
    }),
    (err) => err.code === 'E_INSUFFICIENT',
  );
  assert.equal(db.getAccount('A').frozen, 0, 'A freeze rolled back');
  assert.equal(db.getAccount('B').frozen, 0);
});
