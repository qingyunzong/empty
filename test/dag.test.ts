import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { test } from "node:test";
import { WeightedDag, type DagNode } from "../src/dag.js";
import { RankEngine } from "../src/engine.js";
import { eagerDagWeights, modelPercentile } from "../src/model.js";

const NODES: Record<string, DagNode> = {
  a: { kind: "source" },
  b: { kind: "source" },
  flag: { kind: "source" },
  k: { kind: "const", value: 2 },
  base: { kind: "add", deps: ["a", "b"] },
  scaled: { kind: "mul", deps: ["base", "k"] },
  trap: { kind: "source" }, // no source value provided: throws if evaluated
  chosen: { kind: "cond", pick: "flag", then: "scaled", else: "trap" },
  bonus: { kind: "add", deps: ["chosen", "a"] },
};

const OUTPUTS: Record<string, number> = { chosen: 100, bonus: 200 };

function makeEngine(sources: Record<string, number>): RankEngine {
  return new RankEngine(new WeightedDag(NODES), OUTPUTS, sources);
}

test("lazy evaluation takes only the selected conditional branch", () => {
  const dag = new WeightedDag(NODES);
  const sources = { a: 3, b: 4, flag: 1 };
  const { weights, evaluated } = dag.evaluate(sources, ["chosen", "bonus"]);

  equal(weights.get("chosen"), 14); // (3 + 4) * 2
  equal(weights.get("bonus"), 17);
  ok(!evaluated.has("trap"), "unselected branch must not be evaluated");

  const flipped = dag.evaluate({ a: 3, b: 4, flag: 0, trap: 9 }, ["chosen"]);
  equal(flipped.weights.get("chosen"), 9); // else branch selected
  ok(!flipped.evaluated.has("scaled"), "then branch must not be evaluated");
});

test("unselected branch with a failing node never runs", () => {
  const dag = new WeightedDag(NODES);
  // flag > 0 selects "scaled"; "trap" has no source value and would throw.
  const { weights } = dag.evaluate({ a: 1, b: 2, flag: 5 }, ["chosen"]);
  equal(weights.get("chosen"), 6);
});

test("full DAG evaluation matches the eager sorting-free model", () => {
  const dag = new WeightedDag(NODES);
  const sources = { a: 3, b: 4, flag: 1, trap: 9 };
  const lazy = dag.evaluate(sources, Object.keys(NODES));
  const eager = eagerDagWeights(NODES, sources);
  deepEqual([...lazy.weights.entries()].sort(), [...eager.entries()].sort());
});

test("cycles are detected", () => {
  const dag = new WeightedDag({
    x: { kind: "add", deps: ["y"] },
    y: { kind: "add", deps: ["x"] },
  });
  throws(() => dag.evaluate({}, ["x"]), /cycle detected/);
});

test("a source change republishes weights and all percentiles in one generation", () => {
  const engine = makeEngine({ a: 3, b: 4, flag: 1 });
  const before = engine.read();
  equal(before.generation, 1);
  equal(before.weights.get("chosen"), 14);

  const gen = engine.setSources({ a: 10, flag: 0, trap: 5 });
  equal(gen, 2);
  const after = engine.read();
  equal(after.generation, 2);
  equal(after.weights.get("chosen"), 5); // else branch now selected
  equal(after.weights.get("bonus"), 15);

  // No mixed generation: every published score must be reproducible from
  // the very same view's weights via the item-by-item model.
  const observations = after.scores.map((s) => ({ value: s.value, weight: s.weight }));
  for (const entry of after.scores) {
    equal(entry.score, modelPercentile(observations, entry.value), entry.id);
  }
  // And identical to a fresh engine built from the same sources.
  const fresh = makeEngine({ a: 10, b: 4, flag: 0, trap: 5 });
  deepEqual(
    after.scores.map((s) => [s.id, s.value, s.weight, s.score]),
    fresh.read().scores.map((s) => [s.id, s.value, s.weight, s.score]),
  );
});

test("generation bumps exactly once per source change", () => {
  const engine = makeEngine({ a: 1, b: 1, flag: 1 });
  for (let i = 2; i <= 10; i += 1) {
    equal(engine.setSources({ a: i }), i);
    equal(engine.read().generation, i);
  }
});

test("unknown sources and non-finite values are rejected", () => {
  const engine = makeEngine({ a: 1, b: 1, flag: 1 });
  throws(() => engine.setSources({ nope: 1 }), /unknown source node/);
  throws(() => engine.setSources({ a: Number.NaN }), /must be finite/);
});
