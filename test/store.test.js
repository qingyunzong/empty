import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, StoreError } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-store-'));
}

test('snapshot isolation: reads only see the begin-time snapshot', () => {
  const store = Store.open(tmpdir());
  const t1 = store.begin();
  t1.put('a', 1);
  const v1 = t1.commit();

  const reader = store.begin(); // snapshot at v1
  const t2 = store.begin();
  t2.put('a', 2);
  t2.put('b', 9);
  t2.commit();

  assert.equal(reader.snapshot, v1);
  assert.equal(reader.get('a'), 1);
  assert.equal(reader.get('b'), undefined);
  assert.equal(store.readAt('a', store.head()), 2);
});

test('first-committer-wins: conflict only on directly written keys', () => {
  const store = Store.open(tmpdir());
  const base = store.begin();
  base.put('x', 0);
  base.put('y', 0);
  base.commit();

  const a = store.begin();
  const b = store.begin();
  a.put('x', 1);
  b.put('x', 2);
  b.put('y', 3);
  a.commit();
  assert.throws(() => b.commit(), (e) => e instanceof StoreError && e.code === 'E_CONFLICT');

  // Disjoint writes do not conflict.
  const c = store.begin();
  const d = store.begin();
  c.put('x', 10);
  d.put('y', 20);
  c.commit();
  assert.equal(d.commit(), store.head());
  assert.equal(store.readAt('x', store.head()), 10);
  assert.equal(store.readAt('y', store.head()), 20);
});

test('read-your-own-writes inside a transaction', () => {
  const store = Store.open(tmpdir());
  const tx = store.begin();
  tx.put('k', { n: 1 });
  assert.deepEqual(tx.get('k'), { n: 1 });
  tx.put('k', { n: 2 });
  assert.deepEqual(tx.get('k'), { n: 2 });
  tx.commit();
  assert.deepEqual(store.readAt('k', 1), { n: 2 });
});

// Reference model: a plain list of committed write-sets. Visibility of a key
// at version v is the last write to it at any version <= v. Enumerate every
// (key, version) pair (keys * versions <= 20) and compare against the store.
test('reference model: enumerate all key/version visibility', () => {
  const store = Store.open(tmpdir());
  const keys = ['k0', 'k1', 'k2', 'k3'];
  const reference = []; // reference[v] = writes object of version v+1

  const refReadAt = (key, version) => {
    for (let v = version; v >= 1; v--) {
      const w = reference[v - 1];
      if (Object.hasOwn(w, key)) return w[key];
    }
    return undefined;
  };

  const checkAll = () => {
    const head = store.head();
    assert.equal(head, reference.length);
    for (const key of keys) {
      for (let v = 0; v <= head; v++) {
        assert.deepEqual(
          store.readAt(key, v),
          refReadAt(key, v),
          `visibility mismatch at key=${key} version=${v}`,
        );
      }
    }
    // Full-state view must equal the merge of all versions up to each point.
    for (let v = 0; v <= head; v++) {
      const merged = {};
      for (let i = 0; i < v; i++) Object.assign(merged, reference[i]);
      assert.deepEqual(store.stateAt(v), merged, `state mismatch at version=${v}`);
    }
  };

  checkAll();
  // 5 commits x 4 keys = 20 key-versions, within the enumeration budget.
  for (let round = 0; round < 5; round++) {
    const tx = store.begin();
    for (const key of keys) {
      if ((round + key.length) % 2 === 0 || round === 0) {
        tx.put(key, { round, key });
      }
    }
    tx.commit();
    reference.push(Object.fromEntries(tx.writes));
    checkAll();
  }
});

test('randomized reference-model comparison across processes-safe commits', () => {
  const store = Store.open(tmpdir());
  const keys = ['a', 'b', 'c'];
  const reference = [];
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let round = 0; round < 6; round++) {
    const tx = store.begin();
    for (const key of keys) {
      if (rand() < 0.6) tx.put(key, Math.floor(rand() * 1000));
    }
    tx.commit();
    reference.push(Object.fromEntries(tx.writes));
  }
  for (const key of keys) {
    for (let v = 0; v <= reference.length; v++) {
      let expected;
      for (let i = v; i >= 1; i--) {
        if (Object.hasOwn(reference[i - 1], key)) {
          expected = reference[i - 1][key];
          break;
        }
      }
      assert.deepEqual(store.readAt(key, v), expected);
    }
  }
});
