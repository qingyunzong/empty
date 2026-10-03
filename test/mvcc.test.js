'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obs-store-mvcc-'));
}

test('snapshot isolation: reader sees snapshot from its begin', () => {
  const dir = tmpdir();
  const store = Store.open(dir);

  const t0 = store.begin();
  t0.put('star', '1.0');
  t0.commit();

  const reader = store.begin(); // snapshot at v1
  const writer = store.begin();
  writer.put('star', '2.0');
  writer.commit();

  assert.equal(reader.get('star'), '1.0', 'reader must see its own snapshot');
  assert.equal(store.get('star'), '2.0', 'latest read sees committed value');
  reader.abort();
  store.close();
});

test('read-your-own-writes within a transaction', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  const txn = store.begin();
  txn.put('a', 'x');
  assert.equal(txn.get('a'), 'x');
  txn.delete('a');
  assert.throws(() => txn.get('a'), (err) => err.code === 'NOT_FOUND');
  txn.abort();
  assert.throws(() => store.get('a'), (err) => err.code === 'NOT_FOUND');
  store.close();
});

test('acceptance 1: concurrent writers on same key -> second commit CONFLICT', () => {
  const dir = tmpdir();
  const store = Store.open(dir);

  const t1 = store.begin();
  const t2 = store.begin();
  t1.put('target', 'from-t1');
  t2.put('target', 'from-t2');

  t1.commit();
  assert.throws(() => t2.commit(), (err) => err.code === 'CONFLICT');
  assert.equal(store.get('target'), 'from-t1');
  store.close();
});

test('non-overlapping write sets both commit', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  const t1 = store.begin();
  const t2 = store.begin();
  t1.put('k1', 'a');
  t2.put('k2', 'b');
  t1.commit();
  t2.commit();
  assert.equal(store.get('k1'), 'a');
  assert.equal(store.get('k2'), 'b');
  store.close();
});

test('conflict detected even when other txn committed a delete', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  const t0 = store.begin();
  t0.put('k', 'v');
  t0.commit();

  const t1 = store.begin();
  const t2 = store.begin();
  t1.delete('k');
  t1.commit();
  t2.put('k', 'v2');
  assert.throws(() => t2.commit(), (err) => err.code === 'CONFLICT');
  store.close();
});

test('abort discards buffered writes', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  const txn = store.begin();
  txn.put('k', 'v');
  txn.abort();
  assert.throws(() => store.get('k'), (err) => err.code === 'NOT_FOUND');
  assert.throws(() => txn.put('k', 'x'), (err) => err.code === 'INVALID');
  store.close();
});

test('delete removes key from latest view but history keeps versions', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  let t = store.begin();
  t.put('k', 'v1');
  const { version: v1 } = t.commit();
  t = store.begin();
  t.delete('k');
  t.commit();

  assert.throws(() => store.get('k'), (err) => err.code === 'NOT_FOUND');
  assert.equal(store.get('k', { at: v1 }), 'v1');
  const hist = store.history('k');
  assert.deepEqual(hist.map((h) => h.value), ['v1', null]);
  store.close();
});

test('versions increase monotonically per commit', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  const v1 = (() => { const t = store.begin(); t.put('a', '1'); return t.commit().version; })();
  const v2 = (() => { const t = store.begin(); t.put('b', '2'); return t.commit().version; })();
  assert.equal(v2, v1 + 1);
  store.close();
});
