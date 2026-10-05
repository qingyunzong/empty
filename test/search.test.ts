import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { runSearch } from "../src/search";
import type { Outcome, Problem, Snapshot } from "../src/search";
import { makeGraphProblem, mulberry32 } from "./graph";

const SIZE = 60;
const EXTRA = 120;
const GRAPH_SEED = 42;

function baseline(): { outcome: Outcome<number>; visits: Array<string>; expanded: number } {
  const problem = makeGraphProblem(GRAPH_SEED, SIZE, EXTRA);
  const result = runSearch(problem);
  ok(result.outcome.status === "goal", "baseline should reach the goal");
  return { outcome: result.outcome, visits: result.visits, expanded: result.expanded };
}

test("uninterrupted run is deterministic across repetitions", () => {
  const a = baseline();
  const b = baseline();
  deepEqual(a.visits, b.visits);
  deepEqual(a.outcome, b.outcome);
  equal(a.expanded, a.visits.length);
});

test("random cancel points: resumed output matches uninterrupted run", () => {
  const base = baseline();
  const problem = makeGraphProblem(GRAPH_SEED, SIZE, EXTRA);

  for (let trial = 0; trial < 40; trial++) {
    const rand = mulberry32(1000 + trial);
    let snapshot: Snapshot<number> | undefined = undefined;
    let final: Outcome<number> | undefined = undefined;
    const visits: Array<string> = [];
    let expanded = 0;
    let slices = 0;

    for (;;) {
      slices += 1;
      const cancelAfter = Math.floor(rand() * 6); // 0..5 expansions per slice
      const result = runSearch(problem, { cancelAfter, snapshot });
      visits.push(...result.visits.slice(visits.length));
      expanded = result.expanded;
      if (result.outcome.status === "cancelled") {
        // JSON round-trip: the snapshot must survive serialization.
        snapshot = JSON.parse(JSON.stringify(result.outcome.snapshot));
        continue;
      }
      final = result.outcome;
      break;
    }

    ok(slices > 1, `trial ${trial}: expected at least one cancellation`);
    deepEqual(visits, base.visits, `trial ${trial}: visit order mismatch`);
    equal(expanded, base.expanded, `trial ${trial}: visit count mismatch`);
    deepEqual(final, base.outcome, `trial ${trial}: final result mismatch`);
  }
});

test("budget exhaustion returns frontier and best candidate", () => {
  const base = baseline();
  const problem = makeGraphProblem(GRAPH_SEED, SIZE, EXTRA);
  const budget = 10;
  ok(base.expanded > budget, "baseline must expand more than the budget");

  const result = runSearch(problem, { budget });
  equal(result.expanded, budget);
  equal(result.visits.length, budget);
  deepEqual(result.visits, base.visits.slice(0, budget), "visits must be a prefix of the baseline");

  ok(result.outcome.status === "budget-exhausted");
  if (result.outcome.status !== "budget-exhausted") return;
  const frontier = result.outcome.frontier;

  // Frontier is sorted in pop order and its head is the next state the
  // uninterrupted run would expand.
  for (let i = 1; i < frontier.length; i++) {
    const prev = frontier[i - 1]!;
    const curr = frontier[i]!;
    ok(
      prev.f < curr.f || (prev.f === curr.f && prev.seq < curr.seq),
      "frontier must be sorted by (f, seq)",
    );
  }
  equal(frontier[0]!.key, base.visits[budget]!, "frontier head must be the next baseline visit");

  // Best candidate: min h among expanded states (then min f, then earliest).
  let expectedBestH = Infinity;
  for (const key of result.visits) {
    const h = SIZE - 1 - Number(key.slice(1));
    if (h < expectedBestH) expectedBestH = h;
  }
  ok(result.best !== null);
  equal(result.best!.h, expectedBestH);
  equal(result.best!.key, result.visits[0] === undefined ? null : result.best!.key);
});

test("resuming a budget-exhausted search matches the uninterrupted run", () => {
  const base = baseline();
  const problem = makeGraphProblem(GRAPH_SEED, SIZE, EXTRA);

  const first = runSearch(problem, { budget: 7 });
  ok(first.outcome.status === "budget-exhausted");
  if (first.outcome.status !== "budget-exhausted") return;

  const snapshot = JSON.parse(JSON.stringify(first.outcome.snapshot));
  const second = runSearch(problem, { budget: 100000, snapshot });
  deepEqual(second.visits, base.visits);
  equal(second.expanded, base.expanded);
  deepEqual(second.outcome, base.outcome);
});

test("deterministic expansion order with tied priorities", () => {
  // Uniform costs and zero heuristic: every queued state has f = depth,
  // so expansion must follow insertion (seq) order within each depth.
  const edges: Record<number, Array<{ state: number; cost: number }>> = {
    0: [
      { state: 1, cost: 1 },
      { state: 2, cost: 1 },
      { state: 3, cost: 1 },
    ],
    1: [{ state: 4, cost: 1 }],
    2: [{ state: 4, cost: 1 }],
    3: [],
    4: [],
  };
  const problem: Problem<number> = {
    start: 0,
    isGoal: (s) => s === 4,
    successors: (s) => edges[s] ?? [],
    key: (s) => `n${s}`,
    heuristic: () => 0,
  };
  const result = runSearch(problem);
  deepEqual(result.visits, ["n0", "n1", "n2", "n3", "n4"]);
  ok(result.outcome.status === "goal");
  if (result.outcome.status === "goal") equal(result.outcome.cost, 2);
});

test("unreachable goal exhausts the frontier", () => {
  const problem: Problem<number> = {
    start: 0,
    isGoal: (s) => s === 99,
    successors: (s) => (s === 0 ? [{ state: 1, cost: 1 }] : []),
    key: (s) => `n${s}`,
    heuristic: () => 0,
  };
  const result = runSearch(problem);
  equal(result.outcome.status, "exhausted");
  deepEqual(result.visits, ["n0", "n1"]);
});

test("cancelAfter=0 cancels immediately with a resumable snapshot", () => {
  const base = baseline();
  const problem = makeGraphProblem(GRAPH_SEED, SIZE, EXTRA);
  const first = runSearch(problem, { cancelAfter: 0 });
  equal(first.outcome.status, "cancelled");
  equal(first.expanded, 0);
  if (first.outcome.status !== "cancelled") return;
  const second = runSearch(problem, { snapshot: first.outcome.snapshot });
  deepEqual(second.visits, base.visits);
  deepEqual(second.outcome, base.outcome);
});
