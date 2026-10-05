import test from "node:test";
import assert from "node:assert/strict";
import { rational, quantileRank } from "../src/rational.js";
import {
  WindowState,
  createWindow,
  addEvent,
  correctEvent,
  quantile,
  rankOf,
  countOf,
  size,
  toSortedArray,
} from "../src/window.js";

/** Deterministic PRNG (mulberry32) so failures reproduce exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("quantileRank: ceil(p*n), p=0 selects the minimum", () => {
  assert.equal(quantileRank(rational(0, 1), 10), 1);
  assert.equal(quantileRank(rational(1, 1), 10), 10);
  assert.equal(quantileRank(rational(1, 2), 10), 5);
  assert.equal(quantileRank(rational(1, 2), 9), 5); // ceil(4.5)
  assert.equal(quantileRank(rational(1, 3), 10), 4); // ceil(10/3)
  assert.equal(quantileRank(rational(2, 3), 10), 7); // ceil(20/3)
  assert.equal(quantileRank(rational(1, 100), 3), 1); // tiny p still >= 1
  assert.throws(() => rational(3, 2), /0 <= p <= 1/);
  assert.throws(() => rational(-1, 2), /0 <= p <= 1/);
  assert.throws(() => rational(1, 0), /non-zero/);
});

test("empty window returns empty (null) for quantiles", () => {
  const w = createWindow(3);
  assert.equal(size(w), 0);
  assert.equal(quantile(w, rational(0, 1)), null);
  assert.equal(quantile(w, rational(1, 2)), null);
  assert.equal(quantile(w, rational(1, 1)), null);
  assert.deepEqual(toSortedArray(w), []);
});

test("basic add, eviction deletes oldest, duplicates kept", () => {
  let w = createWindow(3);
  w = addEvent(w, 1, 5);
  w = addEvent(w, 2, 5);
  w = addEvent(w, 3, 1);
  assert.deepEqual(toSortedArray(w), [1, 5, 5]);
  assert.equal(countOf(w, 5), 2);
  w = addEvent(w, 4, 7); // evicts event 1 (value 5)
  assert.deepEqual(toSortedArray(w), [1, 5, 7]);
  assert.equal(countOf(w, 5), 1);
  assert.equal(quantile(w, rational(0, 1)), 1);
  assert.equal(quantile(w, rational(1, 1)), 7);
});

test("correction updates value in place; evicted ids are rejected", () => {
  let w = createWindow(2);
  w = addEvent(w, 1, 10);
  w = addEvent(w, 2, 20);
  w = correctEvent(w, 1, 30);
  assert.deepEqual(toSortedArray(w), [20, 30]);
  w = addEvent(w, 3, 40); // evicts event 1
  assert.throws(() => correctEvent(w, 1, 99), /not live/);
  assert.throws(() => addEvent(w, 2, 1), /already live/);
});

test("model-based: per-step sorted-array oracle, extreme quantiles, duplicates", () => {
  const rand = mulberry32(0xC0FFEE);
  const capacity = 7;
  let w: WindowState = createWindow(capacity);
  const model: { id: number; value: number }[] = [];
  let nextId = 1;

  const sortedModel = () => model.map((e) => e.value).sort((a, b) => a - b);

  for (let step = 0; step < 3000; step++) {
    const doAdd = model.length === 0 || rand() < 0.6;
    if (doAdd) {
      const value = Math.floor(rand() * 11) - 5; // [-5,5]: forces many duplicates
      const id = nextId++;
      w = addEvent(w, id, value);
      model.push({ id, value });
      if (model.length > capacity) model.shift();
    } else {
      const idx = Math.floor(rand() * model.length);
      const value = Math.floor(rand() * 11) - 5;
      w = correctEvent(w, model[idx]!.id, value);
      model[idx]!.value = value;
    }

    const sorted = sortedModel();
    const n = sorted.length;

    // Full contents match the sorted model every step.
    assert.deepEqual(toSortedArray(w), sorted, `step ${step}: contents`);
    assert.equal(size(w), n);

    // Extreme quantiles: p=0 -> min, p=1 -> max.
    assert.equal(quantile(w, rational(0, 1)), sorted[0], `step ${step}: min`);
    assert.equal(quantile(w, rational(1, 1)), sorted[n - 1], `step ${step}: max`);

    // Random rational quantiles checked against the sorted model.
    for (let k = 0; k < 4; k++) {
      const num = Math.floor(rand() * 8);
      const den = 1 + Math.floor(rand() * 8);
      const p = rational(Math.min(num, den), Math.max(num, den));
      const rank = quantileRank(p, n);
      assert.equal(quantile(w, p), sorted[rank - 1], `step ${step}: p=${p.num}/${p.den}`);
    }

    // Rank and duplicate multiplicities for probed values.
    for (let k = 0; k < 4; k++) {
      const v = Math.floor(rand() * 13) - 6;
      assert.equal(rankOf(w, v), sorted.filter((x) => x < v).length, `step ${step}: rankOf(${v})`);
      assert.equal(countOf(w, v), sorted.filter((x) => x === v).length, `step ${step}: countOf(${v})`);
    }
  }
});

test("model-based with corrections-heavy workload and capacity 1", () => {
  const rand = mulberry32(42);
  let w: WindowState = createWindow(1);
  const model: number[] = [];
  let nextId = 1;
  for (let step = 0; step < 500; step++) {
    if (rand() < 0.5 || model.length === 0) {
      const value = Math.floor(rand() * 3); // heavy duplicates
      w = addEvent(w, nextId++, value);
      model.length = 0;
      model.push(value);
    } else {
      const value = Math.floor(rand() * 3);
      w = correctEvent(w, nextId - 1, value);
      model[0] = value;
    }
    const sorted = [...model].sort((a, b) => a - b);
    assert.deepEqual(toSortedArray(w), sorted);
    assert.equal(quantile(w, rational(0, 1)), sorted[0]);
    assert.equal(quantile(w, rational(1, 1)), sorted[sorted.length - 1]);
    assert.equal(quantile(w, rational(1, 2)), sorted[quantileRank(rational(1, 2), sorted.length) - 1]);
  }
});
