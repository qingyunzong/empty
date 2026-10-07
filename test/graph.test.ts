import { test } from "node:test";
import assert from "node:assert/strict";
import { BatchValidationError, DirectedGraph, EdgeOp } from "../src/graph";
import { refReachable, refShortestPath } from "../src/reference";

test("add/remove edges and reachability", () => {
  const g = new DirectedGraph();
  g.addEdge("a", "b");
  g.addEdge("b", "c");
  assert.equal(g.isReachable("a", "c"), true);
  assert.equal(g.isReachable("c", "a"), false);
  assert.deepEqual(g.reachableFrom("a"), ["a", "b", "c"]);

  g.removeEdge("b", "c");
  assert.equal(g.isReachable("a", "c"), false);
  assert.deepEqual(g.reachableFrom("a"), ["a", "b"]);
});

test("self-loops are allowed and do not break queries", () => {
  const g = new DirectedGraph();
  g.addEdge("a", "a");
  assert.equal(g.hasEdge("a", "a"), true);
  assert.equal(g.isReachable("a", "a"), true);
  assert.deepEqual(g.shortestPath("a", "a"), ["a"]); // length-0 path wins
  g.removeEdge("a", "a");
  assert.equal(g.hasEdge("a", "a"), false);
  assert.deepEqual(g.shortestPath("a", "a"), ["a"]); // still trivially reachable
});

test("shortest path: length first, lexicographically smallest sequence on ties", () => {
  const g = new DirectedGraph();
  // Two shortest paths a->d: [a,b,d] and [a,c,d]; "b" < "c" breaks the tie.
  g.applyBatch([
    { type: "add", from: "a", to: "c" },
    { type: "add", from: "a", to: "b" },
    { type: "add", from: "c", to: "d" },
    { type: "add", from: "b", to: "d" },
    { type: "add", from: "a", to: "d" }, // direct edge is shorter than both
  ]);
  assert.deepEqual(g.shortestPath("a", "d"), ["a", "d"]);
  g.removeEdge("a", "d");
  assert.deepEqual(g.shortestPath("a", "d"), ["a", "b", "d"]);
  assert.equal(g.distance("a", "d"), 2);
  assert.equal(g.shortestPath("d", "a"), null);
  assert.equal(g.distance("d", "a"), null);
});

test("batch modifications are atomic: a failing batch changes nothing", () => {
  const g = new DirectedGraph();
  g.applyBatch([
    { type: "add", from: "a", to: "b" },
    { type: "add", from: "b", to: "c" },
  ]);
  const before = g.edges();

  // The remove refers to a missing edge -> whole batch must be rejected.
  assert.throws(
    () =>
      g.applyBatch([
        { type: "add", from: "c", to: "d" },
        { type: "remove", from: "x", to: "y" },
      ]),
    (err: unknown) => err instanceof BatchValidationError,
  );
  assert.deepEqual(g.edges(), before);
  assert.equal(g.isReachable("c", "d"), false);

  // A valid batch applies entirely, including a self-loop.
  g.applyBatch([
    { type: "add", from: "c", to: "d" },
    { type: "add", from: "d", to: "d" },
    { type: "remove", from: "a", to: "b" },
  ]);
  assert.deepEqual(g.edges(), [
    ["b", "c"],
    ["c", "d"],
    ["d", "d"],
  ]);
});

test("removing a missing edge outside a batch also throws", () => {
  const g = new DirectedGraph();
  assert.throws(
    () => g.removeEdge("a", "b"),
    (err: unknown) => err instanceof BatchValidationError,
  );
});

test("affected sources are reported and their cache entries are dropped", () => {
  const g = new DirectedGraph();
  g.applyBatch([
    { type: "add", from: "a", to: "b" },
    { type: "add", from: "b", to: "c" },
    { type: "add", from: "x", to: "y" },
  ]);
  // Populate the cache for every source.
  for (const s of ["a", "b", "c", "x", "y"]) g.reachableFrom(s);
  assert.equal(g.cacheSize, 5);

  // Sources that can reach b in the pre-batch graph: a and b.
  const res = g.removeEdge("b", "c");
  assert.deepEqual(res.affectedSources, ["a", "b"]);
  assert.equal(g.cacheSize, 3); // only a and b were evicted

  // After invalidation, results reflect the new graph.
  assert.deepEqual(g.reachableFrom("a"), ["a", "b"]);
  assert.deepEqual(g.reachableFrom("b"), ["b"]);
  assert.deepEqual(g.reachableFrom("x"), ["x", "y"]);
});

/** Deterministic PRNG (mulberry32) so the fuzz test is reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("fuzz: cache invalidation after edge removal matches per-source BFS reference", () => {
  const rand = rng(20261007);
  const nodes = ["n0", "n1", "n2", "n3", "n4", "n5"];

  for (let iter = 0; iter < 200; iter++) {
    const pick = (): string => nodes[Math.floor(rand() * nodes.length)]!;

    // Random initial graph, self-loops included.
    const initial: EdgeOp[] = [];
    const edgeCount = Math.floor(rand() * 10);
    for (let i = 0; i < edgeCount; i++) initial.push({ type: "add", from: pick(), to: pick() });
    const g = new DirectedGraph();
    g.applyBatch(initial);

    // Populate the cache by querying every source.
    const preReach = new Map<string, Set<string>>();
    for (const s of nodes) {
      g.reachableFrom(s);
      preReach.set(s, refReachable(nodes, g.edges(), s));
    }
    assert.equal(g.cacheSize, nodes.length);

    // Random batch: valid removes (existing edges, no duplicates) + adds.
    const current = g.edges();
    const batch: EdgeOp[] = [];
    const removed = new Set<string>();
    const opCount = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < opCount; i++) {
      if (current.length > 0 && rand() < 0.5) {
        const [u, v] = current[Math.floor(rand() * current.length)]!;
        const key = `${u}->${v}`;
        if (removed.has(key)) continue;
        removed.add(key);
        batch.push({ type: "remove", from: u, to: v });
      } else {
        batch.push({ type: "add", from: pick(), to: pick() });
      }
    }

    const { affectedSources } = g.applyBatch(batch);
    const affected = new Set(affectedSources);

    // Cache: exactly the affected sources were evicted.
    assert.equal(g.cacheSize, nodes.length - affected.size);

    const postEdges = g.edges();
    for (const s of nodes) {
      const refSet = refReachable(nodes, postEdges, s);

      // Soundness: every source whose reachable set actually changed must
      // have been reported as affected (and thus evicted from the cache).
      const before = preReach.get(s)!;
      const changed =
        before.size !== refSet.size || [...before].some((n) => !refSet.has(n));
      if (changed) {
        assert.ok(
          affected.has(s),
          `iter ${iter}: source ${s} changed but was not reported affected`,
        );
      }

      // Post-invalidation queries must match the cache-free reference.
      assert.deepEqual(g.reachableFrom(s), [...refSet].sort());
      for (const d of nodes) {
        assert.deepEqual(
          g.shortestPath(s, d),
          refShortestPath(nodes, postEdges, s, d),
          `iter ${iter}: shortestPath(${s}, ${d})`,
        );
      }
    }
  }
});
