import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { tmpdir, mulberry32, randomSample, randomPatch, randomDate, refScan, TYPES } from './helpers.js';

// Acceptance scenario 1: 5000 mixed add/update/remove operations; find/scan
// results must match a brute-force reference filter exactly.
test('5000 mixed ops: find/scan match brute-force reference', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  const rng = mulberry32(20261003);
  const ref = new Map();
  const pool = []; // live ids, mirrors ref keys
  let nextId = 1;
  let ops = 0;

  const verifySpot = () => {
    for (let i = 0; i < 20 && pool.length; i++) {
      const id = pool[Math.floor(rng() * pool.length)];
      assert.deepStrictEqual(store.find(id), ref.get(id), `find(${id})`);
    }
    for (let i = 0; i < 3; i++) {
      const type = TYPES[Math.floor(rng() * TYPES.length)];
      assert.deepStrictEqual(store.scanByType(type), refScan(ref, { type }), `scanByType(${type})`);
    }
    for (let i = 0; i < 3; i++) {
      const a = randomDate(rng);
      const b = randomDate(rng);
      const [from, to] = a <= b ? [a, b] : [b, a];
      assert.deepStrictEqual(store.scanByDateRange(from, to), refScan(ref, { from, to }), `scan ${from}..${to}`);
    }
  };

  while (ops < 5000) {
    const tx = store.begin();
    const mirror = [];
    const batchPool = [...pool]; // live ids not yet removed in this batch
    const batch = 1 + Math.floor(rng() * 50);
    for (let i = 0; i < batch && ops < 5000; i++, ops++) {
      const r = rng();
      if (r < 0.45 || batchPool.length === 0) {
        const rec = randomSample(rng, `S${String(nextId++).padStart(6, '0')}`);
        tx.add(rec);
        mirror.push(() => {
          ref.set(rec.id, rec);
          pool.push(rec.id);
        });
      } else if (r < 0.8) {
        const id = batchPool[Math.floor(rng() * batchPool.length)];
        const patch = randomPatch(rng);
        tx.update(id, patch);
        mirror.push(() => ref.set(id, { ...ref.get(id), ...patch }));
      } else {
        const idx = Math.floor(rng() * batchPool.length);
        const id = batchPool.splice(idx, 1)[0];
        tx.remove(id);
        mirror.push(() => {
          ref.delete(id);
          pool.splice(pool.indexOf(id), 1);
        });
      }
    }
    tx.commit();
    for (const fn of mirror) fn();
    if (ops % 500 < 50) verifySpot();
    if (ops >= 2500 && store) {
      // Close and reopen mid-stream to exercise WAL recovery.
      store.close();
      store = Store.open(dir);
      verifySpot();
      ops += 50; // ensure the reopen branch runs exactly once
    }
  }

  // Final exhaustive comparison.
  assert.strictEqual(store.scan({}).length, ref.size);
  for (const [id, rec] of ref) assert.deepStrictEqual(store.find(id), rec);
  for (const type of TYPES) assert.deepStrictEqual(store.scanByType(type), refScan(ref, { type }));
  for (let i = 0; i < 25; i++) {
    const a = randomDate(rng);
    const b = randomDate(rng);
    const [from, to] = a <= b ? [a, b] : [b, a];
    assert.deepStrictEqual(store.scanByDateRange(from, to), refScan(ref, { from, to }));
    assert.deepStrictEqual(store.scan({ from, to }), refScan(ref, { from, to }));
    const type = TYPES[Math.floor(rng() * TYPES.length)];
    assert.deepStrictEqual(store.scan({ type, from, to }), refScan(ref, { type, from, to }));
  }
  assert.deepStrictEqual(store.scan({}), refScan(ref, {}));
  store.close();
});
