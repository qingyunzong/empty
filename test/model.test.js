'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reference model: key -> [{ version, value|null }], mirroring the store's
// MVCC semantics with plain Maps.
class RefModel {
  constructor() {
    this.history = new Map();
    this.version = 0;
  }
  apply(ops) {
    this.version++;
    for (const op of ops) {
      if (!this.history.has(op.key)) this.history.set(op.key, []);
      this.history.get(op.key).push({
        version: this.version,
        value: op.type === 'put' ? op.value : null,
      });
    }
    return this.version;
  }
  visibleAt(key, at) {
    const list = this.history.get(key);
    if (!list) return { found: false };
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].version <= at) {
        return list[i].value === null ? { found: false } : { found: true, value: list[i].value };
      }
    }
    return { found: false };
  }
  scanAt(at) {
    const out = [];
    for (const key of this.history.keys()) {
      const r = this.visibleAt(key, at);
      if (r.found) out.push([key, r.value]);
    }
    out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return out;
  }
}

test('acceptance 3: 200 keys x 500 random ops match in-memory reference model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-store-model-'));
  const store = Store.open(dir);
  const ref = new RefModel();
  const rand = mulberry32(20261003);
  const KEYS = 200;
  const OPS = 500;
  const keyOf = (i) => `obs/target-${String(i).padStart(3, '0')}`;

  for (let step = 0; step < OPS; step++) {
    const roll = rand();
    if (roll < 0.75) {
      // Write batch: 1-3 ops in one transaction.
      const batchSize = 1 + Math.floor(rand() * 3);
      const txn = store.begin();
      const batch = [];
      for (let j = 0; j < batchSize; j++) {
        const key = keyOf(Math.floor(rand() * KEYS));
        if (rand() < 0.8) {
          const value = `m=${(rand() * 1000).toFixed(3)}`;
          txn.put(key, value);
          batch.push({ type: 'put', key, value });
        } else {
          txn.delete(key);
          batch.push({ type: 'del', key });
        }
      }
      txn.commit();
      // Model: last write to a key within the batch wins.
      const byKey = new Map();
      for (const op of batch) byKey.set(op.key, op);
      ref.apply([...byKey.values()]);
    } else {
      // Snapshot read: compare full keyspace at a random past version.
      const at = Math.floor(rand() * (ref.version + 1));
      assert.deepEqual(
        store.scan({ at }),
        ref.scanAt(at),
        `snapshot mismatch at version ${at} (step ${step})`
      );
      // Spot-check individual keys at the same version.
      for (let k = 0; k < 5; k++) {
        const key = keyOf(Math.floor(rand() * KEYS));
        const expected = ref.visibleAt(key, at);
        if (expected.found) {
          assert.equal(store.get(key, { at }), expected.value);
        } else {
          assert.throws(() => store.get(key, { at }), (err) => err.code === 'NOT_FOUND');
        }
      }
    }
  }

  // Final full-keyspace comparison at the latest version.
  assert.deepEqual(store.scan(), ref.scanAt(ref.version), 'final state mismatch');
  store.close();

  // Reopen: WAL replay must reproduce the exact same state.
  const reopened = Store.open(dir);
  assert.deepEqual(reopened.scan(), ref.scanAt(ref.version), 'post-restart state mismatch');
  assert.equal(reopened.currentVersion, ref.version);
  reopened.close();
});
