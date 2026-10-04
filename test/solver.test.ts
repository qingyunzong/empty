import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSpec, NormalizedSpec } from "../src/graph";
import {
  solve,
  compareNodeIds,
  compareIdSequences,
  compareCandidates,
  PathCandidate,
} from "../src/solver";

function spec(partial: Record<string, unknown>): NormalizedSpec {
  return normalizeSpec(partial);
}

test("compareNodeIds uses natural numeric order", () => {
  assert.ok(compareNodeIds("N2", "N10") < 0);
  assert.ok(compareNodeIds("N10", "N2") > 0);
  assert.ok(compareNodeIds("A", "B") < 0);
  assert.ok(compareNodeIds("2", "10") < 0);
  assert.equal(compareNodeIds("X1", "X1"), 0);
  assert.ok(compareNodeIds("X01", "X1") !== 0); // deterministic tiebreak
});

test("compareIdSequences: prefix sorts before extension", () => {
  assert.ok(compareIdSequences(["A", "B"], ["A", "B", "C"]) < 0);
  assert.ok(compareIdSequences(["A", "C"], ["A", "B"]) > 0);
  assert.equal(compareIdSequences(["A"], ["A"]), 0);
});

test("compareCandidates priority: maxEdge, then total, then IDs", () => {
  const c = (nodes: string[], maxEdgeCost: number, totalCost: number): PathCandidate => ({
    nodes,
    maxEdgeCost,
    totalCost,
  });
  assert.ok(compareCandidates(c(["A", "B"], 5, 100), c(["A", "C"], 6, 1)) < 0);
  assert.ok(compareCandidates(c(["A", "B"], 5, 9), c(["A", "C"], 5, 10)) < 0);
  assert.ok(compareCandidates(c(["A", "B"], 5, 9), c(["A", "C"], 5, 9)) < 0);
});

test("bottleneck beats total cost", () => {
  const result = solve(
    spec({
      start: "S",
      end: "T",
      edges: [
        { from: "S", to: "A", cost: 1 },
        { from: "A", to: "T", cost: 1 },
        { from: "S", to: "B", cost: 5 },
        { from: "B", to: "T", cost: 5 },
        { from: "S", to: "C", cost: 0 },
        { from: "C", to: "T", cost: 0 },
      ],
    })
  );
  assert.equal(result.found, true);
  assert.deepEqual(result.best!.nodes, ["S", "C", "T"]);
  assert.equal(result.best!.maxEdgeCost, 0);
  assert.equal(result.best!.totalCost, 0);
});

test("higher-total path wins when its bottleneck is lower", () => {
  const result = solve(
    spec({
      start: "S",
      end: "T",
      edges: [
        { from: "S", to: "T", cost: 9 },
        { from: "S", to: "A", cost: 4 },
        { from: "A", to: "T", cost: 6 },
      ],
    })
  );
  assert.deepEqual(result.best!.nodes, ["S", "A", "T"]);
  assert.equal(result.best!.maxEdgeCost, 6);
  assert.equal(result.best!.totalCost, 10);
});

test("ID sequence breaks exact cost ties", () => {
  const result = solve(
    spec({
      start: "S",
      end: "T",
      edges: [
        { from: "S", to: "B", cost: 1 },
        { from: "B", to: "T", cost: 1 },
        { from: "S", to: "A", cost: 1 },
        { from: "A", to: "T", cost: 1 },
      ],
    })
  );
  assert.deepEqual(result.best!.nodes, ["S", "A", "T"]);
});

test("checkpoints must all be visited", () => {
  const result = solve(
    spec({
      start: "S",
      end: "T",
      checkpoints: ["K"],
      edges: [
        { from: "S", to: "T", cost: 1 },
        { from: "S", to: "K", cost: 3 },
        { from: "K", to: "T", cost: 3 },
      ],
    })
  );
  assert.equal(result.simplePathCount, 2);
  assert.equal(result.feasiblePathCount, 1);
  assert.deepEqual(result.best!.nodes, ["S", "K", "T"]);
});

test("maxNodes caps path length", () => {
  const graph = {
    start: "S",
    end: "T",
    edges: [
      { from: "S", to: "T", cost: 10 },
      { from: "S", to: "A", cost: 1 },
      { from: "A", to: "B", cost: 1 },
      { from: "B", to: "T", cost: 1 },
    ],
  };
  const capped = solve(spec({ ...graph, maxNodes: 3 }));
  assert.deepEqual(capped.best!.nodes, ["S", "T"]);
  const uncapped = solve(spec(graph));
  assert.deepEqual(uncapped.best!.nodes, ["S", "A", "B", "T"]);
  assert.equal(uncapped.best!.maxEdgeCost, 1);
});

test("default maxNodes is 12", () => {
  const edges = [{ from: "S", to: "T", cost: 100 }];
  let prev = "S";
  for (let i = 1; i <= 11; i++) {
    edges.push({ from: prev, to: `N${i}`, cost: 1 });
    prev = `N${i}`;
  }
  edges.push({ from: prev, to: "T", cost: 1 });
  const result = solve(spec({ start: "S", end: "T", edges }));
  assert.deepEqual(result.best!.nodes, ["S", "T"]);
});

test("directed edges are one-way; undirected go both ways", () => {
  const directed = solve(
    spec({ start: "A", end: "B", directed: true, edges: [{ from: "B", to: "A", cost: 1 }] })
  );
  assert.equal(directed.found, false);
  const undirected = solve(
    spec({ start: "A", end: "B", edges: [{ from: "B", to: "A", cost: 1 }] })
  );
  assert.equal(undirected.found, true);
});

test("start equals end yields a single-node path", () => {
  const result = solve(spec({ start: "A", end: "A", edges: [] }));
  assert.equal(result.found, true);
  assert.deepEqual(result.best, { nodes: ["A"], maxEdgeCost: 0, totalCost: 0 });
});

test("no feasible path reported", () => {
  const result = solve(
    spec({
      start: "S",
      end: "T",
      checkpoints: ["GONE"],
      edges: [{ from: "S", to: "T", cost: 1 }],
    })
  );
  assert.equal(result.found, false);
  assert.equal(result.best, null);
  assert.equal(result.simplePathCount, 1);
  assert.equal(result.feasiblePathCount, 0);
});

test("invalid specs are rejected", () => {
  assert.throws(() => spec({ start: "S" }));
  assert.throws(() => spec({ start: "S", end: "T", edges: [{ from: "S", to: "T" }] }));
  assert.throws(() => spec({ start: "S", end: "T", edges: [], maxNodes: 0 }));
});

// Exhaustive cross-check on small graphs: an independent brute force that
// enumerates every simple path as a permutation of node subsets must agree
// with the solver on the best witness and on the path counts.

interface BruteResult {
  best: PathCandidate | null;
  simplePathCount: number;
  feasiblePathCount: number;
}

function bruteForce(spec: NormalizedSpec): BruteResult {
  const nodeSet = new Set<string>([spec.start, spec.end]);
  for (const e of spec.edges) {
    nodeSet.add(e.from);
    nodeSet.add(e.to);
  }
  const others = [...nodeSet].filter((n) => n !== spec.start && n !== spec.end);

  const edgeCost = new Map<string, number>();
  const offer = (from: string, to: string, cost: number): void => {
    const key = `${from} ${to}`;
    const prev = edgeCost.get(key);
    if (prev === undefined || cost < prev) edgeCost.set(key, cost);
  };
  for (const e of spec.edges) {
    offer(e.from, e.to, e.cost);
    if (!spec.directed) offer(e.to, e.from, e.cost);
  }

  const checkpoints = new Set(spec.checkpoints);
  let simplePathCount = 0;
  let feasiblePathCount = 0;
  let best: PathCandidate | null = null;

  const consider = (nodes: string[]): void => {
    let total = 0;
    let maxEdge = -Infinity;
    for (let i = 0; i + 1 < nodes.length; i++) {
      const cost = edgeCost.get(`${nodes[i]} ${nodes[i + 1]}`);
      if (cost === undefined) return;
      total += cost;
      if (cost > maxEdge) maxEdge = cost;
    }
    simplePathCount++;
    const present = new Set(nodes);
    for (const cp of checkpoints) {
      if (!present.has(cp)) return;
    }
    feasiblePathCount++;
    const candidate: PathCandidate = {
      nodes,
      maxEdgeCost: maxEdge === -Infinity ? 0 : maxEdge,
      totalCost: total,
    };
    if (best === null || compareCandidates(candidate, best) < 0) best = candidate;
  };

  if (spec.start === spec.end) {
    consider([spec.start]);
  } else {
    const limit = Math.min(spec.maxNodes, nodeSet.size);
    const chosen: string[] = [];
    const used = new Set<string>();
    const pick = (): void => {
      const k = chosen.length + 2;
      if (k <= limit) consider([spec.start, ...chosen, spec.end]);
      if (k >= limit) return;
      for (const n of others) {
        if (used.has(n)) continue;
        used.add(n);
        chosen.push(n);
        pick();
        chosen.pop();
        used.delete(n);
      }
    };
    pick();
  }
  return { best, simplePathCount, feasiblePathCount };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSpec(rand: () => number): NormalizedSpec {
  const n = 2 + Math.floor(rand() * 5); // 2..6 nodes keeps permutations cheap
  const nodes = Array.from({ length: n }, (_, i) => `N${i}`);
  const directed = rand() < 0.5;
  const edges: { from: string; to: string; cost: number }[] = [];
  for (const a of nodes) {
    for (const b of nodes) {
      if (a === b) continue;
      if (rand() < 0.45) {
        edges.push({ from: a, to: b, cost: 1 + Math.floor(rand() * 20) });
      }
    }
  }
  const checkpointCount = Math.floor(rand() * 3); // 0..2
  const checkpoints = [...nodes].sort(() => rand() - 0.5).slice(0, checkpointCount);
  const maxNodes = 2 + Math.floor(rand() * 11); // 2..12
  return spec({
    start: nodes[0],
    end: nodes[n - 1],
    checkpoints,
    maxNodes,
    directed,
    edges,
  });
}

function assertWitnessValid(spec: NormalizedSpec, candidate: PathCandidate): void {
  const nodes = candidate.nodes;
  assert.equal(nodes[0], spec.start);
  assert.equal(nodes[nodes.length - 1], spec.end);
  assert.ok(nodes.length <= spec.maxNodes, "node limit respected");
  assert.equal(new Set(nodes).size, nodes.length, "no repeated nodes");
  for (const cp of spec.checkpoints) assert.ok(nodes.includes(cp), `checkpoint ${cp} visited`);
  const costOf = (from: string, to: string): number | undefined => {
    let best: number | undefined;
    for (const e of spec.edges) {
      const hit = e.from === from && e.to === to;
      const rev = !spec.directed && e.from === to && e.to === from;
      if ((hit || rev) && (best === undefined || e.cost < best)) best = e.cost;
    }
    return best;
  };
  let total = 0;
  let maxEdge = 0;
  for (let i = 0; i + 1 < nodes.length; i++) {
    const cost = costOf(nodes[i]!, nodes[i + 1]!);
    assert.ok(cost !== undefined, `edge ${nodes[i]}->${nodes[i + 1]} exists`);
    total += cost!;
    maxEdge = Math.max(maxEdge, cost!);
  }
  assert.equal(candidate.totalCost, total);
  assert.equal(candidate.maxEdgeCost, maxEdge);
}

test("exhaustive cross-check: solver matches brute force on 400 random small graphs", () => {
  const rand = mulberry32(20261005);
  for (let i = 0; i < 400; i++) {
    const s = randomSpec(rand);
    const expected = bruteForce(s);
    const actual = solve(s);
    assert.equal(actual.simplePathCount, expected.simplePathCount, `simplePathCount case ${i}`);
    assert.equal(actual.feasiblePathCount, expected.feasiblePathCount, `feasiblePathCount case ${i}`);
    assert.deepEqual(actual.best, expected.best, `best witness case ${i}`);
    if (actual.best) assertWitnessValid(s, actual.best);
  }
});
