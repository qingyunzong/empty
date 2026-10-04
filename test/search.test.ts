import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Search, SearchResult, Snapshot } from "../src/index";
import { mulberry32, randomGraph } from "./random-graph";

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("uninterrupted runs are deterministic and visit every node once", () => {
  const spec = randomGraph(42, 50, 4);
  const first = Search.start(spec.graph).run();
  const second = Search.start(spec.graph).run();
  assert.deepEqual(first, second);
  assert.equal(first.status, "complete");
  assert.equal(first.visits, spec.nodeCount);
  assert.equal(first.visitOrder.length, first.visits);
  assert.equal(new Set(first.visitOrder).size, first.visits, "no duplicate visits");
  assert.equal(first.frontier.length, 0);
});

test("cancel + snapshot + resume matches the uninterrupted run (random cancel points)", () => {
  for (let seed = 1; seed <= 80; seed++) {
    const rand = mulberry32(seed * 7919 + 13);
    const nodeCount = 20 + Math.floor(rand() * 40);
    const maxDegree = 1 + Math.floor(rand() * 4);
    const budget = rand() < 0.5 ? undefined : Math.floor(rand() * nodeCount * 1.5);
    const bestK = 1 + Math.floor(rand() * 12);
    const spec = randomGraph(seed, nodeCount, maxDegree);
    const options = budget === undefined ? { bestK } : { bestK, budget };

    const baseline = Search.start(spec.graph, options).run();

    let engine = Search.start(spec.graph, options);
    const cancels = 1 + Math.floor(rand() * 4);
    for (let c = 0; c < cancels; c++) {
      const steps = Math.floor(rand() * 8);
      for (let i = 0; i < steps && engine.step(); i++) {
        // expand up to `steps` nodes before cancelling
      }
      engine.cancel();
      engine.step(); // let the cancellation take effect at the boundary
      const snapshot: Snapshot<number> = jsonRoundTrip(engine.snapshot());
      engine = Search.resume(spec.graph, snapshot);
    }
    const resumed = engine.run();

    assert.equal(resumed.status, baseline.status, `seed ${seed}: status`);
    assert.equal(resumed.visits, baseline.visits, `seed ${seed}: visit count`);
    assert.deepEqual(resumed.visitOrder, baseline.visitOrder, `seed ${seed}: visit order`);
    assert.deepEqual(resumed.frontier, baseline.frontier, `seed ${seed}: frontier`);
    assert.deepEqual(resumed.best, baseline.best, `seed ${seed}: best candidates`);
    assert.deepEqual(resumed, baseline, `seed ${seed}: full result`);
  }
});

test("budget exhaustion returns the frontier and the best candidates", () => {
  const spec = randomGraph(7, 30, 3);
  const bestK = 5;
  const budget = 10;

  const limited = Search.start(spec.graph, { budget, bestK });
  const exhausted = limited.run();

  assert.equal(exhausted.status, "budget-exhausted");
  assert.equal(exhausted.visits, budget);
  assert.ok(exhausted.frontier.length > 0, "frontier is reported");
  assert.equal(new Set(exhausted.frontier).size, exhausted.frontier.length);

  // Best candidates must equal the top-K scores over exactly the visited nodes.
  const expectedBest = exhausted.visitOrder
    .map((key, i) => ({ key, score: spec.scores[Number(key)]!, visitIndex: i + 1 }))
    .sort((a, b) => b.score - a.score || a.visitIndex - b.visitIndex)
    .slice(0, bestK);
  assert.deepEqual(exhausted.best, expectedBest);

  // Resuming the exhausted search with more budget matches the full run.
  const snapshot: Snapshot<number> = jsonRoundTrip(limited.snapshot());
  const finished = Search.resume(spec.graph, snapshot, { additionalBudget: 1000 }).run();
  const full = Search.start(spec.graph, { bestK }).run();
  assert.deepEqual(finished, full);
  assert.equal(finished.status, "complete");
});

test("snapshot survives a JSON round-trip byte-for-byte", () => {
  const spec = randomGraph(99, 40, 3);
  const engine = Search.start(spec.graph, { budget: 15, bestK: 4 });
  engine.run();
  const snapshot = engine.snapshot();
  const restored = Search.resume(spec.graph, jsonRoundTrip(snapshot));
  assert.deepEqual(restored.snapshot(), snapshot);
});

test("edge cases: zero budget, immediate cancel, empty graph", () => {
  const spec = randomGraph(5, 10, 2);

  const zero = Search.start(spec.graph, { budget: 0 }).run();
  assert.equal(zero.status, "budget-exhausted");
  assert.equal(zero.visits, 0);
  assert.deepEqual(zero.visitOrder, []);
  assert.ok(zero.frontier.length > 0);

  const cancelled = Search.start(spec.graph);
  cancelled.cancel();
  const cancelledResult = cancelled.run();
  assert.equal(cancelledResult.status, "cancelled");
  assert.equal(cancelledResult.visits, 0);
  const recovered = Search.resume(spec.graph, jsonRoundTrip(cancelled.snapshot())).run();
  assert.deepEqual(recovered, Search.start(spec.graph).run());

  const empty = Search.start<number>({
    start: () => [],
    neighbors: () => [],
    key: (s) => String(s),
  }).run();
  assert.equal(empty.status, "complete");
  assert.equal(empty.visits, 0);
  assert.deepEqual(empty.frontier, []);
});

test("frontier order is the exact expansion order of the remaining open list", () => {
  const spec = randomGraph(123, 25, 3);
  const engine = Search.start(spec.graph, { budget: 8 });
  const stopped = engine.run();
  assert.equal(stopped.status, "budget-exhausted");

  // A fresh engine replaying the same 8 expansions must report the same
  // frontier, and popping the frontier must follow that exact order.
  const replay = Search.start(spec.graph, { budget: 8 });
  const replayed = replay.run();
  assert.deepEqual(replayed.frontier, stopped.frontier);

  // The next expansions after adding budget must start with frontier[0].
  replay.addBudget(1);
  const before = replay.visits;
  assert.ok(replay.step());
  assert.equal(replay.visits, before + 1);
  assert.equal(replay.visitOrder[before], stopped.frontier[0]);
});

test("result objects are snapshots and do not alias live state", () => {
  const spec = randomGraph(11, 15, 2);
  const engine = Search.start(spec.graph, { budget: 5 });
  const result: SearchResult = engine.run();
  result.visitOrder.push("tampered");
  result.best.length = 0;
  const again = engine.result();
  assert.equal(again.visitOrder.length, 5);
  assert.ok(again.best.length > 0);
});
