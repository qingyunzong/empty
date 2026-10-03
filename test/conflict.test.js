'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { StoreError } = require('../src/errors');

function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-conflict-'));
  Store.init(dir);
  return dir;
}

test('concurrent writers on the same key: second commit gets CONFLICT', () => {
  const store = new Store(tmpdir());
  const seed = store.begin();
  seed.put('target', 'v0');
  seed.commit();

  const txnA = store.begin();
  const txnB = store.begin();
  txnA.put('target', 'vA');
  txnB.put('target', 'vB');

  txnA.commit();
  assert.throws(() => txnB.commit(), (err) => {
    assert.ok(err instanceof StoreError);
    assert.equal(err.code, 'CONFLICT');
    return true;
  });
  // The winning transaction's value is visible; the loser left no trace.
  assert.equal(store.get('target'), 'vA');
  store.close();
});

test('concurrent writers on disjoint keys both commit', () => {
  const store = new Store(tmpdir());
  const txnA = store.begin();
  const txnB = store.begin();
  txnA.put('key-a', '1');
  txnB.put('key-b', '2');
  txnA.commit();
  txnB.commit();
  assert.equal(store.get('key-a'), '1');
  assert.equal(store.get('key-b'), '2');
  store.close();
});

test('read transaction sees the snapshot from its begin, not later commits', () => {
  const store = new Store(tmpdir());
  const seed = store.begin();
  seed.put('k', 'before');
  seed.commit();

  const reader = store.begin();
  const writer = store.begin();
  writer.put('k', 'after');
  writer.commit();

  assert.equal(reader.get('k'), 'before');
  assert.equal(store.get('k'), 'after');
  reader.abort();
  store.close();
});

test('delete then conflict: concurrent put vs delete on same key conflicts', () => {
  const store = new Store(tmpdir());
  const seed = store.begin();
  seed.put('k', 'x');
  seed.commit();

  const deleter = store.begin();
  const writer = store.begin();
  deleter.delete('k');
  writer.put('k', 'y');
  deleter.commit();
  assert.throws(() => writer.commit(), (err) => err.code === 'CONFLICT');
  assert.throws(() => store.get('k'), (err) => err.code === 'NOT_FOUND');
  store.close();
});

test('abort discards buffered writes', () => {
  const store = new Store(tmpdir());
  const txn = store.begin();
  txn.put('k', 'v');
  txn.abort();
  assert.throws(() => store.get('k'), (err) => err.code === 'NOT_FOUND');
  assert.throws(() => txn.put('k', 'v2'), (err) => err.code === 'INVALID');
  store.close();
});
