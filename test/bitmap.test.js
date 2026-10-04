'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bitmap } from '../src/bitmap.js';

// Deterministic PRNG (LCG) so tests are reproducible offline.
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0);
}

test('add/remove/contains matches Set oracle', () => {
  const rand = lcg(42);
  const bm = new Bitmap();
  const set = new Set();
  for (let i = 0; i < 5000; i++) {
    const v = rand() % 200000; // spans multiple 64k chunks
    if (rand() % 3 === 0) {
      bm.remove(v);
      set.delete(v);
    } else {
      bm.add(v);
      set.add(v);
    }
  }
  assert.deepEqual(bm.toArray(), [...set].sort((a, b) => a - b));
  assert.equal(bm.cardinality, set.size);
  for (let i = 0; i < 500; i++) {
    const v = rand() % 200000;
    assert.equal(bm.has(v), set.has(v));
  }
});

test('container encodings: array, run, bitset', () => {
  const sparse = Bitmap.fromArray([1, 100, 4000]);
  assert.equal(sparse.toJSON()[0][1].t, 'a');
  const dense = Bitmap.fromArray(Array.from({ length: 5000 }, (_, i) => i));
  assert.equal(dense.toJSON()[0][1].t, 'r'); // one long run
  const rand = lcg(7);
  const scattered = new Set();
  while (scattered.size < 5000) scattered.add(rand() % 65536);
  const bits = Bitmap.fromArray([...scattered]);
  assert.equal(bits.toJSON()[0][1].t, 'b');
  // run container actually compresses
  const denseJson = JSON.stringify(dense.toJSON());
  assert.ok(denseJson.length < 200, 'run container should be tiny');
});

test('set ops match Set oracle', () => {
  const rand = lcg(99);
  const a = new Set(), b = new Set();
  for (let i = 0; i < 3000; i++) {
    a.add(rand() % 150000);
    b.add(rand() % 150000);
  }
  const ba = Bitmap.fromArray([...a]);
  const bb = Bitmap.fromArray([...b]);
  const sorted = (s) => [...s].sort((x, y) => x - y);
  assert.deepEqual(ba.or(bb).toArray(), sorted(new Set([...a, ...b])));
  assert.deepEqual(ba.and(bb).toArray(), sorted(new Set([...a].filter((x) => b.has(x)))));
  assert.deepEqual(ba.andNot(bb).toArray(), sorted(new Set([...a].filter((x) => !b.has(x)))));
});

test('JSON roundtrip preserves equality', () => {
  const rand = lcg(1234);
  const vals = new Set();
  for (let i = 0; i < 8000; i++) vals.add(rand() % 300000);
  for (let i = 0; i < 3000; i++) vals.add(i); // dense run region
  const bm = Bitmap.fromArray([...vals]);
  const back = Bitmap.fromJSON(JSON.parse(JSON.stringify(bm.toJSON())));
  assert.ok(bm.equals(back));
  assert.deepEqual(back.toArray(), bm.toArray());
});
