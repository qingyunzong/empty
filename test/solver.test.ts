import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { buildGraph } from "../src/graph";
import { solve } from "../src/solver";
import { compareIds, compareSequences } from "../src/compare";
import type { GraphInput } from "../src/types";
import { bruteForceBest, enumerateFeasiblePaths } from "./brute";

function witness(input: GraphInput) {
  return solve(buildGraph(input));
}

test("prefers smaller maximum edge cost over smaller total cost", () => {
  const w = witness({
    edges: [
      { from: "s", to: "a", cost: 5 },
      { from: "a", to: "t", cost: 5 },
      { from: "s", to: "b", cost: 6 },
      { from: "b", to: "t", cost: 1 },
    ],
    start: "s",
    end: "t",
  });
  deepEqual(w.path, ["s", "a", "t"]);
  equal(w.maxEdgeCost, 5);
  equal(w.totalCost, 10);
});

test("breaks maximum-edge ties by total cost", () => {
  const w = witness({
    edges: [
      { from: "s", to: "a", cost: 4 },
      { from: "a", to: "t", cost: 4 },
      { from: "s", to: "b", cost: 4 },
      { from: "b", to: "t", cost: 1 },
    ],
    start: "s",
    end: "t",
  });
  deepEqual(w.path, ["s", "b", "t"]);
  equal(w.maxEdgeCost, 4);
  equal(w.totalCost, 5);
});

test("breaks full cost ties by node-id sequence", () => {
  const w = witness({
    edges: [
      { from: "s", to: "b", cost: 2 },
      { from: "b", to: "t", cost: 2 },
      { from: "s", to: "a", cost: 2 },
      { from: "a", to: "t", cost: 2 },
    ],
    start: "s",
    end: "t",
  });
  deepEqual(w.path, ["s", "a", "t"]);
});

test("compares node ids naturally (numeric-aware)", () => {
  ok(compareIds("n2", "n10") < 0);
  ok(compareIds("a", "b") < 0);
  ok(compareSequences(["s", "n2", "t"], ["s", "n10", "t"]) < 0);
  const w = witness({
    edges: [
      { from: "s", to: "n10", cost: 1 },
      { from: "n10", to: "t", cost: 1 },
      { from: "s", to: "n2", cost: 1 },
      { from: "n2", to: "t", cost: 1 },
    ],
    start: "s",
    end: "t",
  });
  deepEqual(w.path, ["s", "n2", "t"]);
});

test("routes through every checkpoint even when costly", () => {
  const w = witness({
    edges: [
      { from: "s", to: "t", cost: 1 },
      { from: "s", to: "c", cost: 3 },
      { from: "c", to: "t", cost: 3 },
    ],
    start: "s",
    end: "t",
    checkpoints: ["c"],
  });
  deepEqual(w.path, ["s", "c", "t"]);
  equal(w.maxEdgeCost, 3);
});

test("never repeats a node", () => {
  const input: GraphInput = {
    edges: [
      { from: "s", to: "x", cost: 1 },
      { from: "x", to: "y", cost: 1 },
      { from: "y", to: "x", cost: 1 },
      { from: "y", to: "t", cost: 1 },
    ],
    start: "s",
    end: "t",
    directed: true,
  };
  const w = witness(input);
  deepEqual(w.path, ["s", "x", "y", "t"]);
  for (const candidate of enumerateFeasiblePaths(buildGraph(input))) {
    equal(new Set(candidate.path).size, candidate.path.length);
  }
});

test("respects the 12-node visit limit by default", () => {
  const edges = [];
  for (let i = 1; i < 13; i++) edges.push({ from: `n${i}`, to: `n${i + 1}`, cost: 1 });
  const w = witness({ edges, start: "n1", end: "n13" });
  equal(w.found, false);
  const raised = witness({ edges, start: "n1", end: "n13", maxNodes: 13 });
  equal(raised.found, true);
  equal(raised.nodeCount, 13);
});

test("reports no path when the graph is disconnected", () => {
  const w = witness({
    edges: [
      { from: "s", to: "a", cost: 1 },
      { from: "b", to: "t", cost: 1 },
    ],
    start: "s",
    end: "t",
  });
  equal(w.found, false);
  deepEqual(w.path, []);
  equal(w.maxEdgeCost, null);
  equal(w.totalCost, null);
});

test("handles start equal to end", () => {
  const w = witness({
    edges: [{ from: "s", to: "a", cost: 1 }],
    start: "s",
    end: "s",
    checkpoints: ["s"],
  });
  equal(w.found, true);
  deepEqual(w.path, ["s"]);
  equal(w.maxEdgeCost, null);
  equal(w.totalCost, 0);
});

test("honours the directed flag", () => {
  const edges = [
    { from: "s", to: "m", cost: 1 },
    { from: "t", to: "m", cost: 1 },
  ];
  const undirected = witness({ edges, start: "s", end: "t" });
  equal(undirected.found, true);
  deepEqual(undirected.path, ["s", "m", "t"]);
  const directed = witness({ edges, start: "s", end: "t", directed: true });
  equal(directed.found, false);
});

test("accepts numeric node ids", () => {
  const w = witness({
    edges: [
      { from: 1, to: 2, cost: 2 },
      { from: 2, to: 3, cost: 2 },
    ],
    start: 1,
    end: 3,
  });
  deepEqual(w.path, ["1", "2", "3"]);
});

test("validates malformed input", () => {
  throws(() => buildGraph(null));
  throws(() => buildGraph({ start: "s", end: "t" }));
  throws(() => buildGraph({ edges: [], start: "s", end: "t", maxNodes: 0 }));
  throws(() =>
    buildGraph({ edges: [{ from: "s", to: "t", cost: Number.NaN }], start: "s", end: "t" })
  );
  throws(() =>
    buildGraph({
      nodes: ["s", "t"],
      edges: [{ from: "s", to: "t", cost: 1 }],
      start: "s",
      end: "t",
      checkpoints: ["ghost"],
    })
  );
});

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInput(rand: () => number): GraphInput {
  const n = 2 + Math.floor(rand() * 7);
  const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && rand() < 0.35) {
        edges.push({ from: nodes[i], to: nodes[j], cost: Math.floor(rand() * 24) - 3 });
      }
    }
  }
  return {
    nodes,
    edges,
    start: nodes[Math.floor(rand() * n)],
    end: nodes[Math.floor(rand() * n)],
    checkpoints: nodes.filter(() => rand() < 0.3),
    maxNodes: rand() < 0.7 ? 12 : 2 + Math.floor(rand() * 11),
    directed: rand() < 0.5,
  };
}

test("matches exhaustive enumeration on 600 random small graphs", () => {
  const rand = mulberry32(20261005);
  let feasible = 0;
  for (let i = 0; i < 600; i++) {
    const graph = buildGraph(randomInput(rand));
    const expected = bruteForceBest(graph);
    const actual = solve(graph);
    if (expected === null) {
      equal(actual.found, false, `case ${i}: expected no path`);
      continue;
    }
    feasible++;
    equal(actual.found, true, `case ${i}: expected a path`);
    deepEqual(actual.path, expected.path, `case ${i}: witness path`);
    const expectedMax =
      expected.maxEdgeCost === Number.NEGATIVE_INFINITY ? null : expected.maxEdgeCost;
    equal(actual.maxEdgeCost, expectedMax, `case ${i}: max edge cost`);
    equal(actual.totalCost, expected.totalCost, `case ${i}: total cost`);
  }
  ok(feasible > 200, `expected many feasible cases, got ${feasible}`);
});
