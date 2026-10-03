import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/database.js';

test('secondary index scans active freezes ordered by (priority, account)', async () => {
  const db = new Database();
  db.setAccount('A', 1000);
  db.setAccount('B', 1000);
  db.setAccount('C', 1000);

  const ids = {};
  await db.transaction(async (tx) => {
    ids.bLow = await tx.freeze('B', 10, 1);
    ids.aHigh = await tx.freeze('A', 10, 9);
    ids.aLow = await tx.freeze('A', 10, 1);
    ids.cMid = await tx.freeze('C', 10, 5);
  });

  assert.deepEqual(
    db.scanByPriority().map((f) => [f.priority, f.account, f.id]),
    [[1, 'A', ids.aLow], [1, 'B', ids.bLow], [5, 'C', ids.cMid], [9, 'A', ids.aHigh]],
  );

  // Cancel inside a transaction removes the entry from the index on commit.
  await db.transaction(async (tx) => tx.cancel(ids.aLow));
  assert.deepEqual(
    db.scanByPriority().map((f) => [f.priority, f.account, f.id]),
    [[1, 'B', ids.bLow], [5, 'C', ids.cMid], [9, 'A', ids.aHigh]],
  );
  assert.equal(db.getAccount('A').frozen, 10);
});
