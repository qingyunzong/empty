'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-store-'));
}

// Deterministic PRNG so the randomized visibility test is reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Reference model: an in-memory list of committed versions. The value of
// `key` visible at version V is the last write to that key at any
// version <= V.
function referenceGet(versions, key, at) {
  for (let v = at; v >= 1; v--) {
    const writes = versions[v - 1];
    if (writes && Object.prototype.hasOwnProperty.call(writes, key)) {
      return writes[key];
    }
  }
  return undefined;
}

test('snapshot visibility matches reference model for every (key, version) pair', async () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const rand = lcg(20261004);

  const keyCount = 9; // well under the 20 key/version budget
  const keys = Array.from({ length: keyCount }, (_, i) => `k${i}`);
  const probeKeys = [...keys, 'never-written'];
  const commitCount = 12;
  const versions = [];

  for (let c = 0; c < commitCount; c++) {
    const tx = await store.begin();
    const writes = {};
    const n = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const key = keys[Math.floor(rand() * keys.length)];
      const value = { seq: c, n: Math.floor(rand() * 1000) };
      tx.put(key, value);
      writes[key] = value;
    }
    const { version } = await tx.commit();
    assert.equal(version, c + 1);
    versions.push(writes);
  }

  const current = await store.currentVersion();
  assert.equal(current, commitCount);

  // Enumerate the full visibility matrix: every key x every version.
  for (let v = 0; v <= current; v++) {
    for (const key of probeKeys) {
      const expected = referenceGet(versions, key, v);
      const actual = await store.getAt(key, v);
      assert.deepEqual(actual, expected, `key=${key} at version=${v}`);
    }
    // Whole-state materialization must agree too.
    const state = await store.stateAt(v);
    for (const key of probeKeys) {
      assert.deepEqual(state[key], referenceGet(versions, key, v), `state key=${key} at version=${v}`);
    }
  }
});

test('transaction reads only see its snapshot version', async () => {
  const dir = tmpDir();
  const store = new Store(dir);

  const tx1 = await store.begin();
  tx1.put('a', 1);
  await tx1.commit();

  const stale = await store.begin(); // snapshot at v1
  const tx2 = await store.begin();
  tx2.put('a', 2);
  await tx2.commit(); // v2

  assert.equal(await stale.get('a'), 1, 'stale snapshot must not see v2');
  assert.equal(await store.getAt('a', await store.currentVersion()), 2);
});

test('first committer wins; conflicting write set gets E_CONFLICT', async () => {
  const dir = tmpDir();
  const store = new Store(dir);

  const setup = await store.begin();
  setup.put('x', 0);
  await setup.commit();

  const a = await store.begin();
  const b = await store.begin();
  a.put('x', 'a');
  b.put('x', 'b');
  await a.commit();
  await assert.rejects(b.commit(), (err) => err.code === 'E_CONFLICT');

  // Non-overlapping write sets both succeed.
  const c = await store.begin();
  const d = await store.begin();
  c.put('p', 1);
  d.put('q', 2);
  await c.commit();
  const res = await d.commit();
  assert.equal(res.version, 4);
});

test('committed history is never overwritten', async () => {
  const dir = tmpDir();
  const store = new Store(dir);

  const t1 = await store.begin();
  t1.put('doc', { rev: 1 });
  await t1.commit();
  const t2 = await store.begin();
  t2.put('doc', { rev: 2 });
  await t2.commit();

  assert.deepEqual(await store.getAt('doc', 1), { rev: 1 });
  assert.deepEqual(await store.getAt('doc', 2), { rev: 2 });
});
