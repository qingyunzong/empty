'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Profile } = require('../src/profile.js');
const { referenceState } = require('../test-reference/reference.js');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertMatchesReference(profile, points) {
  const ref = referenceState(points);
  assert.deepEqual([...profile.depths], ref.depths);
  assert.deepEqual(profile.inversionPairList(), ref.inversions);
  assert.deepEqual(profile.maxInversionLayer(), ref.maxInversionLayer);
  assert.deepEqual(profile.missingStats(), ref.missing);
}

test('differential: random upsert/retract sequences match brute-force reference', () => {
  for (const seed of [1, 7, 42, 1337, 20261004]) {
    const rand = mulberry32(seed);
    for (let trial = 0; trial < 40; trial += 1) {
      const profile = new Profile('diff');
      const live = new Map(); // depth -> {temp, version}
      const depthPool = Array.from({ length: 20 }, (_, i) => i * 50 + Math.floor(rand() * 40));
      const ops = 60;
      for (let op = 0; op < ops; op += 1) {
        const depth = depthPool[Math.floor(rand() * depthPool.length)];
        const time = Math.floor(rand() * 1e6);
        if (live.has(depth) && rand() < 0.35) {
          profile.retract(depth, time);
          live.delete(depth);
        } else {
          const temp = Math.round(rand() * 2000) / 100; // 0..20 C
          const version = (live.get(depth)?.version ?? 0) + 1;
          profile.upsert(depth, temp, version, time);
          live.set(depth, { temp, version });
        }
        const points = [...live.entries()].map(([d, v]) => ({ depth: d, temp: v.temp }));
        assert.ok(points.length <= 20);
        assertMatchesReference(profile, points);
      }
    }
  }
});

test('incremental missing blocks: extend range, split, merge, shrink', () => {
  const p = new Profile('m');
  p.upsert(50, 5, 1, 0);
  assert.deepEqual(p.missingStats().blocks, []);
  p.upsert(60, 5, 1, 0);
  assert.deepEqual(p.missingStats().blocks, [{ start: 51, end: 59, count: 9 }]);
  p.upsert(40, 5, 1, 0); // extend range downward
  assert.deepEqual(p.missingStats().blocks, [
    { start: 41, end: 49, count: 9 },
    { start: 51, end: 59, count: 9 },
  ]);
  p.upsert(55, 5, 1, 0); // split second block
  assert.deepEqual(p.missingStats().blocks, [
    { start: 41, end: 49, count: 9 },
    { start: 51, end: 54, count: 4 },
    { start: 56, end: 59, count: 4 },
  ]);
  p.retract(55, 0); // merge the split blocks back
  assert.deepEqual(p.missingStats().blocks, [
    { start: 41, end: 49, count: 9 },
    { start: 51, end: 59, count: 9 },
  ]);
  p.retract(40, 0); // shrink range: first block disappears
  assert.deepEqual(p.missingStats().blocks, [{ start: 51, end: 59, count: 9 }]);
  p.retract(60, 0);
  p.retract(50, 0);
  assert.deepEqual(p.missingStats().blocks, []);
});

test('inversion threshold is strict: exactly +0.5 C is not an inversion', () => {
  const p = new Profile('t');
  p.upsert(10, 7.0, 1, 0);
  p.upsert(20, 7.5, 1, 0);
  assert.deepEqual(p.inversionPairList(), []);
  p.upsert(20, 7.5 + 1e-9, 2, 0);
  assert.deepEqual(p.inversionPairList(), [[10, 20]]);
});

test('max inversion layer picks longest run of adjacent inversion pairs', () => {
  const p = new Profile('L');
  // Run of 3 inversion pairs across 10..40, isolated pair at 90..100.
  const rows = [
    [10, 1], [20, 2], [30, 3], [40, 4],
    [50, 0], // break
    [90, 1], [100, 2],
  ];
  rows.forEach(([d, t], i) => p.upsert(d, t, 1, i));
  assert.deepEqual(p.maxInversionLayer(), { from: 10, to: 40, pairCount: 3 });
  p.retract(30, 0);
  // Runs become 10->20->40 (2 pairs) and 50->90->100 (2 pairs);
  // tie on pairCount is broken by wider depth span.
  assert.deepEqual(p.maxInversionLayer(), { from: 50, to: 100, pairCount: 2 });
});
