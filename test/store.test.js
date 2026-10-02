import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, stateToJson } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walstore-store-'));
}

// Deterministic RNG (mulberry32) so the random model comparison is
// reproducible and failures are falsifiable.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sortedCopy(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? sortedCopy(value) : value;
  }
  return out;
}

test('acceptance 1: replay --to 1234 matches the snapshot taken at that moment', () => {
  const dir = tmpdir();
  const store = new Store(dir).open();
  const random = rng(1234);
  const model = new Map();
  let snapshotAt1234 = null;
  for (let i = 1; i <= 2000; i++) {
    const device = `dev-${Math.floor(random() * 20)}`;
    const key = `metric-${Math.floor(random() * 15)}`;
    const ck = JSON.stringify([device, key]);
    if (random() < 0.2) {
      store.apply({ device, key, del: true });
      model.delete(ck);
    } else {
      const value = Math.floor(random() * 100000) / 100;
      store.apply({ device, key, value });
      model.set(ck, value);
    }
    if (i === 1234) snapshotAt1234 = new Map(model);
  }
  // Checkpoint past the target to prove replay uses checkpoint + WAL tail.
  store.checkpoint();

  const { seq, state } = store.replay(1234);
  assert.equal(seq, 1234);
  assert.deepEqual(state, snapshotAt1234);

  // Reopen (full recovery path) and replay again: must be identical.
  store.close();
  const reopened = new Store(dir).open();
  assert.deepEqual(reopened.replay(1234).state, snapshotAt1234);
  // Live path and replay path agree at the tip.
  assert.deepEqual(reopened.replay(2000).state, reopened.state);
  reopened.close();
});

test('acceptance 2: corrupted index is reported by audit while replay stays correct', () => {
  const dir = tmpdir();
  const store = new Store(dir).open();
  store.apply({ device: 'dev-a', key: 'temp', value: 21.5 });
  store.apply({ device: 'dev-a', key: 'hum', value: 40 });
  store.apply({ device: 'dev-b', key: 'temp', value: 19 });
  assert.deepEqual(store.audit(), []);
  const expected = stateToJson(store.replay().state);
  store.close();

  // Corrupt the persisted index: phantom key and a dropped key.
  const indexPath = path.join(dir, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index.devices['dev-a'].push('phantom');
  index.devices['dev-b'] = [];
  fs.writeFileSync(indexPath, JSON.stringify(index));

  const reopened = new Store(dir).open();
  const divergences = reopened.audit();
  assert.deepEqual(divergences, [
    { device: 'dev-a', key: 'phantom', kind: 'index_only' },
    { device: 'dev-b', key: 'temp', kind: 'replay_only' },
  ]);
  // WAL replay (the source of truth) is unaffected by the corrupted index.
  assert.deepEqual(stateToJson(reopened.replay().state), expected);
  reopened.close();
});

test('replay to a nonexistent sequence fails with NO_SUCH_TXN', () => {
  const dir = tmpdir();
  const store = new Store(dir).open();
  store.apply({ device: 'd', key: 'k', value: 1 });
  assert.throws(
    () => store.replay(2),
    (error) => error.code === 'NO_SUCH_TXN',
  );
  assert.throws(
    () => store.replay(-1),
    (error) => error.code === 'NO_SUCH_TXN',
  );
  store.close();
});

test('checksum failure reports the offset and stops recovery', () => {
  const dir = tmpdir();
  const store = new Store(dir).open();
  for (let i = 0; i < 5; i++) store.apply({ device: 'd', key: `k${i}`, value: i });
  store.close();
  // Corrupt one payload byte inside the third record (a complete frame).
  const walPath = path.join(dir, 'wal.log');
  const buf = fs.readFileSync(walPath);
  const firstLen = 8 + buf.readUInt32LE(0);
  const secondLen = 8 + buf.readUInt32LE(firstLen);
  const thirdOffset = firstLen + secondLen;
  buf[thirdOffset + 12] ^= 0xff;
  fs.writeFileSync(walPath, buf);
  assert.throws(
    () => new Store(dir).open(),
    (error) => {
      assert.equal(error.code, 'CHECKSUM_MISMATCH');
      assert.equal(error.offset, thirdOffset);
      assert.match(error.message, /offset \d+/);
      return true;
    },
  );
});

test('random operation sequence matches a reference model at random points', () => {
  const dir = tmpdir();
  let store = new Store(dir).open();
  const random = rng(0xc0ffee);
  const ops = [];
  const model = new Map();
  const probes = new Set();
  while (probes.size < 30) probes.add(1 + Math.floor(random() * 600));
  const snapshots = new Map();

  for (let i = 1; i <= 600; i++) {
    const device = `dev-${Math.floor(random() * 8)}`;
    const key = `key-${Math.floor(random() * 12)}`;
    const ck = JSON.stringify([device, key]);
    let op;
    if (random() < 0.25) {
      op = { device, key, del: true };
      model.delete(ck);
    } else {
      const value = { reading: Math.floor(random() * 1000), unit: 'kPa' };
      op = { device, key, value };
      model.set(ck, value);
    }
    ops.push(op);
    store.apply(op);
    if (i === 150) store.checkpoint(); // exercise checkpoint + tail replay
    if (i === 300) {
      // Simulate a restart mid-sequence.
      store.close();
      const reopened = new Store(dir).open();
      assert.deepEqual(reopened.state, model);
      store = reopened;
    }
    if (probes.has(i)) snapshots.set(i, new Map(model));
  }
  store.checkpoint();

  for (const [seq, expected] of snapshots) {
    assert.deepEqual(store.replay(seq).state, expected, `replay mismatch at seq ${seq}`);
  }
  assert.deepEqual(store.replay().state, model);
  assert.deepEqual(store.audit(), []);
  store.close();
});

test('replay --to 0 yields the empty state', () => {
  const dir = tmpdir();
  const store = new Store(dir).open();
  store.apply({ device: 'd', key: 'k', value: 1 });
  assert.deepEqual(store.replay(0).state, new Map());
  store.close();
});
