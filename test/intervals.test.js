'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, setOverlaps, referenceOverlaps } = require('../src/intervals');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('zero-length defect touching the lot boundary does not block', () => {
  const lotInterval = [100, 200]; // half-open [100, 200)
  assert.equal(referenceOverlaps([[200, 200]], lotInterval), false, 'zero-length defect at right boundary');
  assert.equal(referenceOverlaps([[100, 100]], lotInterval), false, 'zero-length defect at left boundary');
  assert.equal(referenceOverlaps([[150, 150]], lotInterval), false, 'zero-length defect inside lot is empty');
  assert.equal(setOverlaps(normalize([[200, 200]]), lotInterval), false);
  assert.equal(setOverlaps(normalize([[150, 150]]), lotInterval), false);
});

test('boundary touching intervals do not overlap (left-closed right-open)', () => {
  const lot = [100, 200];
  assert.equal(referenceOverlaps([[200, 300]], lot), false, 'touching at right edge');
  assert.equal(referenceOverlaps([[0, 100]], lot), false, 'touching at left edge');
  assert.equal(referenceOverlaps([[199, 200]], lot), true, 'strictly inside right edge overlaps');
  assert.equal(referenceOverlaps([[100, 101]], lot), true, 'strictly inside left edge overlaps');
  assert.equal(referenceOverlaps([[50, 250]], lot), true, 'covering defect overlaps');
  assert.equal(referenceOverlaps([[150, 160]], lot), true, 'interior defect overlaps');
});

test('normalized set matches reference enumeration for every candidate batch', () => {
  const rand = mulberry32(20261002);
  const pick = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  for (let iter = 0; iter < 3000; iter++) {
    const defectCount = pick(0, 6);
    const defects = [];
    for (let i = 0; i < defectCount; i++) {
      const s = pick(90, 210);
      const len = rand() < 0.3 ? 0 : pick(0, 30); // frequent zero-length defects
      defects.push([s, s + len]);
    }
    const normalized = normalize(defects);
    // Enumerate every candidate batch lot and compare fast path vs reference.
    for (let c = 0; c < 5; c++) {
      const s = pick(95, 205);
      const lot = [s, s + pick(0, 40)];
      assert.equal(
        setOverlaps(normalized, lot),
        referenceOverlaps(defects, lot),
        `mismatch iter=${iter} lot=${lot} defects=${JSON.stringify(defects)}`,
      );
    }
  }
});

test('normalize keeps touching intervals separate and merges overlaps', () => {
  assert.deepEqual(normalize([[0, 10], [10, 20]]), [[0, 10], [10, 20]]);
  assert.deepEqual(normalize([[0, 10], [5, 20]]), [[0, 20]]);
  assert.deepEqual(normalize([[5, 5], [0, 1]]), [[0, 1]]);
});
