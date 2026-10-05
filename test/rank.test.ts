import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { modelPercentile, sortedModelScores } from "../src/model.js";
import { WeightedRank, type Observation } from "../src/rank.js";

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function nearlyEqual(actual: number, expected: number, message: string): void {
  ok(Math.abs(actual - expected) <= 1e-12, `${message}: ${actual} != ${expected}`);
}

test("empty set returns empty results", () => {
  const rank = new WeightedRank();
  deepEqual(rank.scores(), []);
  equal(rank.percentileOf(1), null);
  equal(rank.scoreOf("missing"), null);
  equal(rank.totalWeight(), 0);
});

test("mid-rank percentile: less weight + half equal weight over total", () => {
  const rank = new WeightedRank();
  rank.upsert("a", 10, 2);
  rank.upsert("b", 20, 4);
  rank.upsert("c", 20, 2);
  rank.upsert("d", 30, 2);
  // total = 10
  equal(rank.percentileOf(10), 1 / 10); // (0 + 2/2) / 10
  equal(rank.percentileOf(20), 5 / 10); // (2 + 6/2) / 10
  equal(rank.percentileOf(30), 9 / 10); // (8 + 2/2) / 10
  equal(rank.scoreOf("b"), 5 / 10);
  equal(rank.scoreOf("c"), 5 / 10);
});

test("updates are exact", () => {
  const rank = new WeightedRank();
  rank.upsert("a", 10, 2);
  rank.upsert("b", 20, 4);
  rank.upsert("a", 30, 1); // exact replacement, not accumulation
  equal(rank.totalWeight(), 5);
  deepEqual(rank.get("a"), { value: 30, weight: 1 });
  equal(rank.percentileOf(30), (4 + 0.5) / 5);
  rank.upsert("a", 30, 3); // weight-only update
  equal(rank.totalWeight(), 7);
  equal(rank.percentileOf(30), (4 + 1.5) / 7);
});

test("deletes are exact", () => {
  const rank = new WeightedRank();
  rank.upsert("a", 10, 2);
  rank.upsert("b", 20, 4);
  equal(rank.remove("a"), true);
  equal(rank.remove("a"), false); // already gone, no double subtract
  equal(rank.totalWeight(), 4);
  equal(rank.percentileOf(20), 2 / 4);
  equal(rank.scoreOf("a"), null);
  rank.remove("b");
  deepEqual(rank.scores(), []);
  equal(rank.percentileOf(20), null);
});

test("invalid observations are rejected", () => {
  const rank = new WeightedRank();
  let threw = 0;
  for (const [value, weight] of [
    [Number.NaN, 1],
    [1, -1],
    [1, Number.POSITIVE_INFINITY],
  ] as Array<[number, number]>) {
    try {
      rank.upsert("x", value, weight);
    } catch {
      threw += 1;
    }
  }
  equal(threw, 3);
  equal(rank.size, 0);
});

test("fuzz: index matches item-by-item and sorted models after every op", () => {
  const rand = lcg(20261005);
  const rank = new WeightedRank();
  const reference = new Map<string, Observation>();
  const ids = Array.from({ length: 30 }, (_, i) => `id${i}`);
  const values = [1, 2, 3, 5, 8, 13, 21]; // small pool to force ties

  for (let step = 0; step < 500; step += 1) {
    const id = ids[Math.floor(rand() * ids.length)] as string;
    if (rand() < 0.3) {
      rank.remove(id);
      reference.delete(id);
    } else {
      const value = values[Math.floor(rand() * values.length)] as number;
      const weight = Math.floor(rand() * 1000) / 100 + (rand() < 0.1 ? 0 : 0.005);
      rank.upsert(id, value, weight);
      reference.set(id, { value, weight });
    }

    // Item-by-item accumulation model, exact same summation order.
    for (const [rid, o] of reference) {
      equal(rank.scoreOf(rid), modelPercentile(reference.values(), o.value), `step ${step} ${rid}`);
    }
    equal(rank.percentileOf(7), modelPercentile(reference.values(), 7), `step ${step} probe`);

    // Sorted model, tolerance for different summation order.
    const sortedScores = sortedModelScores([...reference.entries()]);
    const actual = rank.scores();
    equal(actual.length, sortedScores.size, `step ${step} size`);
    for (const entry of actual) {
      nearlyEqual(entry.score, sortedScores.get(entry.id) as number, `step ${step} ${entry.id}`);
    }
  }
});
