import test from "node:test";
import assert from "node:assert/strict";
import { RankedLibrary } from "../src/engine";
import { naivePercentiles, sortingPercentiles, WeightedItem } from "../src/model";
import { assertScoresClose, buildLibrary, mulberry32 } from "./helpers";

function itemsOf(snap: {
  observations: ReadonlyMap<string, { value: number; weightNode: string }>;
  weights: ReadonlyMap<string, number>;
}): WeightedItem[] {
  return [...snap.observations.entries()].map(([id, o]) => ({
    id,
    value: o.value,
    weight: snap.weights.get(o.weightNode)!,
  }));
}

test("one commit updates weights and all percentiles as a single generation", () => {
  const lib = buildLibrary();
  const s0 = lib.getSnapshot();
  assert.equal(s0.generation, 0);
  assert.equal(s0.scores.size, 0, "empty set returns empty scores");

  const s1 = lib.commit([]);
  assert.equal(s1.generation, 1);
  // weights: w_a=5, w_b=8, w_c=5 (mode=1 -> hi branch)
  assert.deepEqual(s1.weights, new Map([["w_a", 5], ["w_b", 8], ["w_c", 5]]));
  // scores recomputed from the same generation's weights via the naive model
  assertScoresClose(s1.scores, naivePercentiles(itemsOf(s1)));
  assertScoresClose(s1.scores, sortingPercentiles(itemsOf(s1)));

  const s2 = lib.commit([["base", 10], ["mode", 0]]);
  assert.equal(s2.generation, 2);
  // w_a=11, w_b=20, w_c=10 (mode=0 -> lo branch, 20*0.5)
  assert.deepEqual(s2.weights, new Map([["w_a", 11], ["w_b", 20], ["w_c", 10]]));
  assertScoresClose(s2.scores, naivePercentiles(itemsOf(s2)));

  // no mixed-generation reads: the old snapshot is untouched
  assert.equal(s1.generation, 1);
  assert.deepEqual(s1.weights, new Map([["w_a", 5], ["w_b", 8], ["w_c", 5]]));
  assert.equal(s1.scores.get("obs2"), s1.scores.get("obs2"));
});

test("snapshot is frozen and detached from later commits", () => {
  const lib = buildLibrary();
  const s1 = lib.commit([]);
  assert.throws(() => {
    (s1 as { generation: number }).generation = 99;
  }, TypeError);
  const weightsBefore = [...s1.weights.entries()];
  lib.commit([["base", 100]]);
  assert.deepEqual([...s1.weights.entries()], weightsBefore);
});

test("failed commit leaves the previous generation intact", () => {
  const lib = buildLibrary();
  const s1 = lib.commit([]);
  assert.throws(() => lib.commit([["unknown_source", 1]]), /unknown source/);
  assert.equal(lib.getSnapshot().generation, s1.generation);
  assert.equal(lib.getSnapshot(), s1);
});

test("weights match full DAG evaluation; scores match both models (randomized)", () => {
  const lib = buildLibrary();
  const rand = mulberry32(1234);
  for (let round = 0; round < 60; round++) {
    const snap = lib.commit([
      ["base", Math.floor(rand() * 50)],
      ["bonus", Math.floor(rand() * 10)],
      ["mode", rand() < 0.5 ? 0 : 1],
    ]);
    assert.equal(snap.generation, round + 1);
    // full DAG evaluation cross-check (deterministic, exact)
    assert.deepEqual(snap.weights, lib.evaluateWeightsWithModel(), `round ${round}`);
    // percentile models cross-check
    const items = itemsOf(snap);
    assertScoresClose(snap.scores, naivePercentiles(items), 1e-9);
    assertScoresClose(snap.scores, sortingPercentiles(items), 1e-9);
  }
});

test("empty observation set yields empty scores after commit", () => {
  const lib = new RankedLibrary();
  lib.addSource("s", 1);
  lib.addNode("w", { kind: "derived", deps: ["s"], compute: (v) => v[0] });
  const snap = lib.commit([]);
  assert.equal(snap.scores.size, 0);
  assert.equal(snap.weights.size, 0);
});
