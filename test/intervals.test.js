import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, union, intersect, difference, containsPoint, gaps, intervalsOverlap,
} from '../src/intervals.js';

test('adjacent boundaries [0,5) and [5,9) do not overlap', () => {
  assert.equal(intervalsOverlap({ start: 0, end: 5 }, { start: 5, end: 9 }), false);
  assert.deepEqual(
    intersect(normalize([{ start: 0, end: 5 }]), normalize([{ start: 5, end: 9 }])),
    [],
  );
  // normalization merges touching half-open intervals
  assert.deepEqual(normalize([{ start: 5, end: 9 }, { start: 0, end: 5 }]), [{ start: 0, end: 9 }]);
});

test('normalize sorts, merges overlaps and adjacency', () => {
  assert.deepEqual(
    normalize([{ start: 8, end: 10 }, { start: 1, end: 3 }, { start: 2, end: 5 }, { start: 5, end: 6 }]),
    [{ start: 1, end: 6 }, { start: 8, end: 10 }],
  );
});

test('intersect and difference basics', () => {
  const a = normalize([{ start: 0, end: 10 }]);
  const b = normalize([{ start: 3, end: 5 }, { start: 8, end: 20 }]);
  assert.deepEqual(intersect(a, b), [{ start: 3, end: 5 }, { start: 8, end: 10 }]);
  assert.deepEqual(difference(a, b), [{ start: 0, end: 3 }, { start: 5, end: 8 }]);
});

test('invalid intervals raise E_INTERVAL', () => {
  for (const bad of [{ start: 5, end: 5 }, { start: 7, end: 2 }, { start: 0.5, end: 3 }, { start: 0 }]) {
    assert.throws(() => normalize([bad]), (err) => err.code === 'E_INTERVAL');
  }
});

test('gaps within a domain', () => {
  const set = normalize([{ start: 0, end: 4 }, { start: 8, end: 10 }]);
  assert.deepEqual(gaps(set, 0, 12), [{ start: 4, end: 8 }, { start: 10, end: 12 }]);
});

// --- property test: random small intervals vs O(n^2) point-set reference ---

function mulberry32(seed) {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randIntervals(rng, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor(rng() * 24);
    const len = 1 + Math.floor(rng() * 6);
    out.push({ start, end: start + len });
  }
  return out;
}

function refPoints(intervals, lo, hi) {
  const pts = new Set();
  for (const { start, end } of intervals) {
    for (let p = Math.max(start, lo); p < Math.min(end, hi); p += 1) pts.add(p);
  }
  return pts;
}

function pointsOf(set, lo, hi) {
  const pts = new Set();
  for (let p = lo; p < hi; p += 1) if (containsPoint(set, p)) pts.add(p);
  return pts;
}

test('random small intervals match O(n^2) reference for union/intersect/difference', () => {
  const rng = mulberry32(20261003);
  const LO = -2;
  const HI = 32;
  for (let iter = 0; iter < 300; iter += 1) {
    const rawA = randIntervals(rng, 1 + Math.floor(rng() * 5));
    const rawB = randIntervals(rng, 1 + Math.floor(rng() * 5));
    const a = normalize(rawA);
    const b = normalize(rawB);
    const refA = refPoints(rawA, LO, HI);
    const refB = refPoints(rawB, LO, HI);

    const refUnion = new Set([...refA, ...refB]);
    const refInter = new Set([...refA].filter((p) => refB.has(p)));
    const refDiff = new Set([...refA].filter((p) => !refB.has(p)));

    assert.deepEqual(pointsOf(union(a, b), LO, HI), refUnion, `union iter=${iter}`);
    assert.deepEqual(pointsOf(intersect(a, b), LO, HI), refInter, `intersect iter=${iter}`);
    assert.deepEqual(pointsOf(difference(a, b), LO, HI), refDiff, `difference iter=${iter}`);
  }
});
