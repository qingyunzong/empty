import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/mvcc.js';

// Classic write skew: the invariant "checking + savings >= 0" is enforced
// by each transaction in application code. Under snapshot isolation both
// transactions read a consistent snapshot, write DISJOINT keys, and both
// commit — the invariant is violated. This test documents that SI allows
// write skew; it is expected behavior, not a bug.
test('write skew CAN occur under snapshot isolation (explicitly expected)', () => {
  const db = new Database();
  db.createTable('accounts');

  const seed = db.begin();
  seed.write('accounts', 'checking', 100);
  seed.write('accounts', 'savings', 100);
  seed.commit();

  const withdraw = (from: string, amount: number) => {
    const txn = db.begin();
    const checking = txn.read('accounts', 'checking') as number;
    const savings = txn.read('accounts', 'savings') as number;
    // Invariant checked against the transaction's own snapshot.
    assert.ok(checking + savings - amount >= 0, 'invariant holds in snapshot');
    txn.write('accounts', from, (from === 'checking' ? checking : savings) - amount);
    return txn;
  };

  const t1 = withdraw('checking', 150); // writes 'checking' only
  const t2 = withdraw('savings', 150); // writes 'savings' only

  // Disjoint write-sets -> no write-write conflict -> BOTH commit.
  t1.commit();
  t2.commit();

  const verify = db.begin();
  const checking = verify.read('accounts', 'checking') as number;
  const savings = verify.read('accounts', 'savings') as number;
  assert.equal(checking, -50);
  assert.equal(savings, -50);
  // The invariant is violated: write skew occurred and is observable.
  assert.ok(checking + savings < 0, 'write skew: invariant violated after both commits');
});
