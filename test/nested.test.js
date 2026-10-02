import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, StoreError } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wx-nested-'));
}

test('three-level nesting: aborting the middle level removes only its writes', () => {
  const store = new Store(tmpdir());
  const l1 = store.begin();
  l1.set('a', 1);
  const l2 = l1.begin();
  l2.set('b', 2);
  const l3 = l2.begin();
  l3.set('c', 3);
  l3.commit(); // merges into l2
  assert.equal(l2.get('c'), 3);

  const l2sibling = l1.begin();
  l2sibling.set('d', 4);
  l2sibling.commit(); // merges into l1, unaffected by l2 abort

  l2.abort(); // kills b and the merged c
  assert.equal(l1.get('b'), undefined);
  assert.equal(l1.get('c'), undefined);
  assert.equal(l1.get('a'), 1);
  assert.equal(l1.get('d'), 4);

  l1.commit();
  assert.deepEqual(store.snapshot(), { a: 1, d: 4 });
  store.close();
});

test('aborting a sub-transaction also aborts its still-open children', () => {
  const store = new Store(tmpdir());
  const l1 = store.begin();
  const l2 = l1.begin();
  const l3 = l2.begin();
  l3.set('x', 1);
  l2.abort();
  assert.equal(l3.status, 'aborted');
  assert.throws(() => l3.set('y', 2), (err) => err.code === 'CLOSED');
  l1.set('keep', true);
  l1.commit();
  assert.deepEqual(store.snapshot(), { keep: true });
  store.close();
});

test('aborting the root discards the whole tree', () => {
  const store = new Store(tmpdir());
  const l1 = store.begin();
  l1.set('a', 1);
  const l2 = l1.begin();
  l2.set('b', 2);
  l2.commit();
  l1.abort();
  assert.deepEqual(store.snapshot(), {});
  store.close();
});

test('abort on a closed transaction returns CLOSED', () => {
  const store = new Store(tmpdir());
  const tx = store.begin();
  tx.commit();
  assert.throws(
    () => tx.abort(),
    (err) => err instanceof StoreError && err.code === 'CLOSED',
  );
  assert.throws(
    () => tx.commit(),
    (err) => err.code === 'CLOSED',
  );
  assert.throws(
    () => tx.set('k', 1),
    (err) => err.code === 'CLOSED',
  );
  store.close();
});
