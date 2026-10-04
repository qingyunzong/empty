import test from "node:test";
import assert from "node:assert/strict";
import { WeightedRankIndex } from "../src/rankIndex";
import { naivePercentiles, sortingPercentiles, WeightedItem } from "../src/model";
import { assertClose, assertScoresClose, mulberry32 } from "./helpers";

test("percentile = (strictly-less weight + half equal weight) / total weight", () => {
  const index = new WeightedRankIndex();
  index.set("a", 10, 1);
  index.set("b", 20, 2);
  index.set("c", 30, 3);
  // total = 6
  assertClose(index.percentileOf(10)!, (0 + 0.5) / 6);
  assertClose(index.percentileOf(20)!, (1 + 1) / 6);
  assertClose(index.percentileOf(30)!, (3 + 1.5) / 6);
  // query value not present: equal weight is zero
  assertClose(index.percentileOf(15)!, 1 / 6);
  assertClose(index.percentileOf(0)!, 0);
  assertClose(index.percentileOf(100)!, 1);
});

test("equal values share half of their combined weight", () => {
  const index = new WeightedRankIndex();
  index.set("a", 5, 1);
  index.set("b", 5, 3);
  index.set("c", 7, 2);
  // total = 6; value 5: (0 + 0.5*4)/6; value 7: (4 + 1)/6
  const scores = index.scores();
  assertClose(scores.get("a")!, 2 / 6);
  assertClose(scores.get("b")!, 2 / 6);
  assertClose(scores.get("c")!, 5 / 6);
});

test("empty set returns empty results", () => {
  const index = new WeightedRankIndex();
  assert.equal(index.percentileOf(1), null);
  assert.equal(index.scores().size, 0);
  // zero total weight behaves like empty
  index.set("z", 1, 0);
  assert.equal(index.percentileOf(1), null);
  assert.equal(index.scores().size, 0);
});

test("updates and deletes are exact", () => {
  const index = new WeightedRankIndex();
  index.set("a", 1, 1);
  index.set("b", 2, 1);
  assertClose(index.total, 2);
  // update replaces the old contribution exactly
  index.set("a", 3, 2);
  assertClose(index.total, 3);
  assertClose(index.percentileOf(2)!, (0 + 0.5) / 3);
  assertClose(index.percentileOf(3)!, (1 + 1) / 3);
  // delete removes exactly what was added
  assert.equal(index.delete("a"), true);
  assertClose(index.total, 1);
  assertClose(index.percentileOf(2)!, 0.5);
  assert.equal(index.delete("missing"), false);
  assert.equal(index.delete("b"), true);
  assert.equal(index.size, 0);
  assertClose(index.total, 0);
  assert.equal(index.scores().size, 0);
});

test("rejects invalid input", () => {
  const index = new WeightedRankIndex();
  assert.throws(() => index.set("x", NaN, 1), RangeError);
  assert.throws(() => index.set("x", 1, -1), RangeError);
  assert.throws(() => index.set("x", 1, Infinity), RangeError);
});

test("randomized ops cross-checked against per-item accumulation and sorting models", () => {
  const rand = mulberry32(42);
  const index = new WeightedRankIndex();
  const shadow = new Map<string, WeightedItem>();

  const checkAll = (step: number) => {
    const items = [...shadow.values()];
    assertScoresClose(index.scores(), naivePercentiles(items), 1e-9);
    assertScoresClose(index.scores(), sortingPercentiles(items), 1e-9);
    const total = items.reduce((s, it) => s + it.weight, 0);
    assertClose(index.total, total, 1e-9, `total weight at step ${step}`);
    assert.equal(index.size, shadow.size);
  };

  for (let step = 0; step < 800; step++) {
    const id = `id${Math.floor(rand() * 60)}`;
    if (rand() < 0.7) {
      const value = Math.floor(rand() * 16); // small range forces ties
      const weight = Math.floor(rand() * 100) / 10;
      index.set(id, value, weight);
      shadow.set(id, { id, value, weight });
    } else {
      index.delete(id);
      shadow.delete(id);
    }
    if (step % 20 === 0) checkAll(step);
  }
  checkAll(800);
});
