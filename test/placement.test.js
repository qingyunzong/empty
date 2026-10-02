'use strict';

// Acceptance 1: for n <= 9 the library placement (max retention-weighted
// restore subset within staging capacity) matches brute-force enumeration.
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectPlacement } = require('../lib/scheduler');

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

function bruteForceMaxWeight(items, capacity) {
  let best = 0;
  const n = items.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    let weight = 0;
    let size = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        size += items[i].size;
        weight += items[i].retention;
      }
    }
    if (size <= capacity && weight > best) best = weight;
  }
  return best;
}

test('placement matches brute-force enumeration for n<=9', () => {
  const rand = mulberry32(20261003);
  let cases = 0;
  for (let n = 1; n <= 9; n++) {
    for (let iter = 0; iter < 60; iter++) {
      const items = [];
      for (let i = 0; i < n; i++) {
        items.push({
          id: `obj-${i}`,
          size: 1 + Math.floor(rand() * 20),
          retention: 1 + Math.floor(rand() * 5),
        });
      }
      const capacity = Math.floor(rand() * 61);
      const expected = bruteForceMaxWeight(items, capacity);
      const got = selectPlacement(items, capacity);
      assert.equal(got.weight, expected, `n=${n} iter=${iter} capacity=${capacity}`);
      const picked = new Set(got.ids);
      assert.equal(picked.size, got.ids.length, 'ids unique');
      let used = 0;
      let weight = 0;
      for (const item of items) {
        if (picked.has(item.id)) {
          used += item.size;
          weight += item.retention;
        }
      }
      assert.ok(used <= capacity, 'fits capacity');
      assert.equal(weight, got.weight, 'reported weight matches picked set');
      // determinism
      assert.deepEqual(selectPlacement(items, capacity), got);
      cases++;
    }
  }
  assert.equal(cases, 9 * 60);
});

test('placement edge cases', () => {
  assert.deepEqual(selectPlacement([], 10), { weight: 0, size: 0, ids: [] });
  assert.deepEqual(selectPlacement([{ id: 'a', size: 5, retention: 3 }], 4), { weight: 0, size: 0, ids: [] });
  const got = selectPlacement(
    [
      { id: 'a', size: 10, retention: 1 },
      { id: 'b', size: 4, retention: 5 },
      { id: 'c', size: 6, retention: 5 },
    ],
    10,
  );
  assert.deepEqual(got.ids, ['b', 'c']);
  assert.equal(got.weight, 10);
});
