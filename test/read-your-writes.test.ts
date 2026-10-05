import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/mvcc.js';

test('read-your-own-writes: staged writes visible to self, invisible to others', () => {
  const db = new Database();
  db.createTable('users');

  const seed = db.begin();
  seed.write('users', 'alice', 'active');
  seed.commit();

  const t1 = db.begin();
  t1.write('users', 'alice', 'suspended');
  t1.write('users', 'bob', 'active');

  // Own staged writes are visible inside the transaction.
  assert.equal(t1.read('users', 'alice'), 'suspended');
  assert.equal(t1.read('users', 'bob'), 'active');

  // A concurrent transaction still sees the committed snapshot.
  const t2 = db.begin();
  assert.equal(t2.read('users', 'alice'), 'active');
  assert.equal(t2.read('users', 'bob'), undefined);

  // Overwriting a staged write: the latest staged value wins.
  t1.write('users', 'alice', 'banned');
  assert.equal(t1.read('users', 'alice'), 'banned');

  // Staged delete: own read sees absence, others still see the old value.
  t1.delete('users', 'alice');
  assert.equal(t1.read('users', 'alice'), undefined);
  assert.equal(t2.read('users', 'alice'), 'active');

  t1.commit();
  const t3 = db.begin();
  assert.equal(t3.read('users', 'alice'), undefined);
  assert.equal(t3.read('users', 'bob'), 'active');
});

test('scan overlays staged writes on the snapshot', () => {
  const db = new Database();
  db.createTable('kv');
  const seed = db.begin();
  seed.write('kv', 'a', 1);
  seed.write('kv', 'b', 2);
  seed.commit();

  const t = db.begin();
  t.write('kv', 'b', 20);
  t.write('kv', 'c', 30);
  t.delete('kv', 'a');
  assert.deepEqual(t.scan('kv'), [
    ['b', 20],
    ['c', 30],
  ]);
});
