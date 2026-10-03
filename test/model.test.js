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
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reference model: key -> list of { version, value } (value null = deleted).
class Model {
  constructor() {
    this.versions = new Map();
    this.current = 0;
  }

  commit(writes) {
    this.current += 1;
    for (const [key, value] of writes) {
      if (!this.versions.has(key)) this.versions.set(key, []);
      this.versions.get(key).push({ version: this.current, value });
    }
    return this.current;
  }

  getAt(key, version) {
    const list = this.versions.get(key);
    if (!list) return undefined;
    let found;
    for (const entry of list) {
      if (entry.version > version) break;
      found = entry;
    }
    return found && found.value !== null ? found.value : undefined;
  }
}

const KEY_COUNT = 200;
const OP_COUNT = 500;

test('500 random ops over 200 keys match in-memory reference model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-model-'));
  Store.init(dir);
  let store = new Store(dir);
  const model = new Model();
  const rand = mulberry32(0x5eed);

  const keys = Array.from({ length: KEY_COUNT }, (_, i) => `obs-${i}`);
  const pickKey = () => keys[Math.floor(rand() * KEY_COUNT)];

  for (let op = 0; op < OP_COUNT; op++) {
    const roll = rand();
    if (roll < 0.35) {
      // put
      const key = pickKey();
      const value = `m=${op}:${Math.floor(rand() * 1e6)}`;
      const txn = store.begin();
      txn.put(key, value);
      const { version } = txn.commit();
      assert.equal(version, model.commit([[key, value]]), `version drift at op ${op}`);
    } else if (roll < 0.5) {
      // delete (only meaningful if present; model comparison covers both)
      const key = pickKey();
      const txn = store.begin();
      txn.delete(key);
      const { version } = txn.commit();
      assert.equal(version, model.commit([[key, null]]), `version drift at op ${op}`);
    } else if (roll < 0.8) {
      // snapshot read at a random historical version
      const key = pickKey();
      const at = Math.floor(rand() * (model.current + 1));
      const expected = model.getAt(key, at);
      if (expected === undefined) {
        assert.throws(() => store.get(key, at), (err) => err.code === 'NOT_FOUND', `op ${op} key ${key} @${at}`);
      } else {
        assert.equal(store.get(key, at), expected, `op ${op} key ${key} @${at}`);
      }
    } else if (roll < 0.9) {
      // read-your-writes + snapshot consistency inside a transaction
      const key = pickKey();
      const txn = store.begin();
      const snapshotVersion = txn.snapshotVersion;
      const expected = model.getAt(key, snapshotVersion);
      if (expected === undefined) {
        assert.throws(() => txn.get(key), (err) => err.code === 'NOT_FOUND');
      } else {
        assert.equal(txn.get(key), expected);
      }
      txn.abort();
    } else {
      // reopen from disk and verify full current state against the model
      store.close();
      store = new Store(dir);
      assert.equal(store.currentVersion, model.current);
      for (const key of keys) {
        const expected = model.getAt(key, model.current);
        if (expected === undefined) {
          assert.throws(() => store.get(key), (err) => err.code === 'NOT_FOUND', `reopen key ${key}`);
        } else {
          assert.equal(store.get(key), expected, `reopen key ${key}`);
        }
      }
    }
  }

  // Final exhaustive per-key comparison across every historical version.
  for (const key of keys) {
    for (let version = 0; version <= model.current; version++) {
      const expected = model.getAt(key, version);
      if (expected === undefined) {
        assert.throws(() => store.get(key, version), (err) => err.code === 'NOT_FOUND');
      } else {
        assert.equal(store.get(key, version), expected);
      }
    }
  }
  store.close();
});
