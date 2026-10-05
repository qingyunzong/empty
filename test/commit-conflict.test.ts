import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommitConflictError, Database } from '../src/mvcc.js';

test('commit conflict evidence: first committer wins, loser gets detailed evidence', () => {
  const db = new Database();
  db.createTable('accounts');

  const seed = db.begin();
  seed.write('accounts', 'a', 100);
  seed.commit();

  const t1 = db.begin();
  const t2 = db.begin();
  assert.equal(t1.snapshotTs, t2.snapshotTs);

  t1.write('accounts', 'a', 80);
  t2.write('accounts', 'a', 60);

  const ts1 = t1.commit();

  let err: CommitConflictError | undefined;
  try {
    t2.commit();
  } catch (e) {
    assert.ok(e instanceof CommitConflictError);
    err = e;
  }
  assert.ok(err, 't2.commit() must abort with a write-write conflict');
  // Evidence: exact key, the loser's snapshot, and the winning commitTs.
  assert.equal(err.txnId, t2.id);
  assert.deepEqual(err.conflicts, [
    { table: 'accounts', key: 'a', snapshotTs: t2.snapshotTs, conflictingCommitTs: ts1 },
  ]);
  assert.match(err.message, /write-write conflict/);

  // The loser's staged write was never applied.
  const check = db.begin();
  assert.equal(check.read('accounts', 'a'), 80);
});

test('disjoint write-sets commit without conflict (no false positives)', () => {
  const db = new Database();
  db.createTable('t');
  const t1 = db.begin();
  const t2 = db.begin();
  t1.write('t', 'x', 1);
  t2.write('t', 'y', 2);
  t1.commit();
  assert.doesNotThrow(() => t2.commit());
});

test('commit validates ONLY the write-set: a stale read-set never aborts', () => {
  const db = new Database();
  db.createTable('t');
  const seed = db.begin();
  seed.write('t', 'watched', 0);
  seed.write('t', 'mine', 0);
  seed.commit();

  const reader = db.begin();
  assert.equal(reader.read('t', 'watched'), 0); // read-set contains 'watched'

  const updater = db.begin();
  updater.write('t', 'watched', 1);
  updater.commit(); // 'watched' advances past reader's snapshot

  reader.write('t', 'mine', 1); // write-set is disjoint
  assert.doesNotThrow(() => reader.commit()); // SI: read-set is not validated
});
