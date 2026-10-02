import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRework, selectReworkNaive, compareIdSets } from '../src/optimize.js';
import { mulberry32 } from './helpers.js';

function randomInstance(rand, n) {
  const skus = ['S1', 'S2', 'S3'];
  const candidates = [];
  for (let i = 0; i < n; i += 1) {
    candidates.push({
      id: `D${String(i).padStart(3, '0')}`,
      sku: skus[Math.floor(rand() * skus.length)],
      cost: 1 + Math.floor(rand() * 20),
      net: Math.floor(rand() * 200) - 40, // sometimes negative
    });
  }
  const stockBySku = new Map(skus.map((s) => [s, Math.floor(rand() * (n / 2 + 1))]));
  const budget = Math.floor(rand() * n * 12);
  return { candidates, budget, stockBySku };
}

test('compareIdSets orders lexicographically with prefix-shorter-first', () => {
  assert.ok(compareIdSets(['A'], ['B']) < 0);
  assert.ok(compareIdSets(['A', 'B'], ['B']) < 0);
  assert.ok(compareIdSets(['A'], ['A', 'B']) < 0);
  assert.equal(compareIdSets(['A'], ['A']), 0);
});

test('D: exact solver matches naive enumeration on random batches of <= 20 defects', () => {
  const rand = mulberry32(20261003);
  for (let trial = 0; trial < 150; trial += 1) {
    const n = 1 + Math.floor(rand() * 16); // 1..16
    const { candidates, budget, stockBySku } = randomInstance(rand, n);
    const exact = selectRework(candidates, { budget, stockBySku });
    const naive = selectReworkNaive(candidates, { budget, stockBySku });
    assert.deepEqual(exact, naive, `mismatch at trial ${trial} (n=${n})`);
  }
});

test('D: exact solver matches naive enumeration at the n = 20 boundary', () => {
  const rand = mulberry32(20);
  for (let trial = 0; trial < 3; trial += 1) {
    const { candidates, budget, stockBySku } = randomInstance(rand, 20);
    const exact = selectRework(candidates, { budget, stockBySku });
    const naive = selectReworkNaive(candidates, { budget, stockBySku });
    assert.deepEqual(exact, naive, `mismatch at boundary trial ${trial}`);
  }
});

test('empty candidate set selects nothing', () => {
  assert.deepEqual(selectRework([], { budget: 10, stockBySku: new Map() }), []);
  assert.deepEqual(selectReworkNaive([], { budget: 10, stockBySku: new Map() }), []);
});
