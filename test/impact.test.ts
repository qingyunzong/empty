import assert from "node:assert/strict";
import test from "node:test";
import { enumerateImpactPaths } from "../src/evidence.ts";
import { diffGraphs, makeGraph, unionGraph, type SymbolGraph } from "../src/graph.ts";
import { analyzeImpact } from "../src/impact.ts";
import { parseGraph } from "../src/io.ts";

test("maps a change to its entry via the shortest chain", () => {
  // api -> service -> repo -> db ; api2 -> util
  const edges: Array<readonly [string, string]> = [
    ["api", "service"],
    ["service", "repo"],
    ["repo", "db"],
    ["api2", "util"],
  ];
  const oldGraph = makeGraph(edges, ["api", "api2"]);
  // db's references change (db modified); everything else identical.
  const newGraph = makeGraph([...edges, ["db", "driver"]], ["api", "api2"]);

  const report = analyzeImpact(oldGraph, newGraph);
  // `db` is modified (new outgoing edge); `driver` is added.
  assert.deepEqual([...report.changed].sort(), ["db", "driver"]);

  const apiImpact = report.byEntry.get("api");
  assert.ok(apiImpact);
  assert.deepEqual(apiImpact.chain, ["db", "repo", "service", "api"]);
  assert.equal(apiImpact.changed, "db");

  assert.deepEqual(report.unaffectedEntries, ["api2"]);
  assert.equal(report.byEntry.has("api2"), false);
});

test("deleted symbols keep their old-graph impact (union semantics)", () => {
  // Old graph: handler -> helper. New graph deletes `helper` entirely.
  const oldGraph = makeGraph([["handler", "helper"]], ["handler"]);
  const newGraph = makeGraph([["handler", "other"]], ["handler"]);

  const report = analyzeImpact(oldGraph, newGraph);
  assert.ok(report.changed.has("helper"), "helper is removed");
  assert.ok(report.changed.has("other"), "other is added");
  assert.ok(report.changed.has("handler"), "handler's references changed");

  // The deleted symbol still impacts the entry through the old edge.
  const impact = report.byEntry.get("handler");
  assert.ok(impact);
  assert.equal(impact.chain[impact.chain.length - 1], "handler");
  // Shortest chain wins: handler changed directly, so length-1 chain exists.
  assert.deepEqual(impact.chain, ["handler"]);

  // The union graph still contains the deleted symbol and its old edge.
  assert.ok(unionGraph(oldGraph, newGraph).edges.get("handler")!.has("helper"));
});

test("deleted-only symbol with no direct entry change still impacts entry", () => {
  // Old: api -> mid -> gone. New: `gone` deleted and mid rewired, but suppose
  // only the deletion happened (mid unchanged, so `mid` is not "modified"
  // unless its edges changed). Here mid keeps referencing nothing new.
  const oldGraph = makeGraph(
    [
      ["api", "mid"],
      ["mid", "gone"],
    ],
    ["api"],
  );
  const newGraph = makeGraph([["api", "mid"]], ["api"]);

  const report = analyzeImpact(oldGraph, newGraph);
  assert.ok(report.changed.has("gone"));
  assert.ok(report.changed.has("mid")); // mid lost an outgoing edge
  const impact = report.byEntry.get("api");
  assert.ok(impact);
  // Shortest is mid -> api (length 2); the deleted `gone` would give length 3.
  assert.deepEqual(impact.chain, ["mid", "api"]);
});

test("diffGraphs classifies added / removed / modified", () => {
  const oldGraph = makeGraph(
    [
      ["a", "b"],
      ["c", "d"],
    ],
    ["a"],
  );
  const newGraph = makeGraph(
    [
      ["a", "b"],
      ["c", "e"],
      ["f", "g"],
    ],
    ["a"],
  );
  const diff = diffGraphs(oldGraph, newGraph);
  assert.deepEqual([...diff.added].sort(), ["e", "f", "g"]);
  assert.deepEqual([...diff.removed].sort(), ["d"]);
  assert.deepEqual([...diff.modified].sort(), ["c"]);
  assert.deepEqual([...diff.changed].sort(), ["c", "d", "e", "f", "g"]);
});

test("identical graphs produce no impact", () => {
  const graph = makeGraph([["api", "db"]], ["api"]);
  const report = analyzeImpact(graph, graph);
  assert.equal(report.changed.size, 0);
  assert.equal(report.byEntry.size, 0);
  assert.deepEqual(report.unaffectedEntries, ["api"]);
});

test("parseGraph validates input and reads no network", () => {
  const graph = parseGraph({
    edges: [["a", "b"]],
    entries: ["a"],
  });
  assert.ok(graph.edges.get("a")!.has("b"));
  assert.ok(graph.entries.has("a"));
  assert.throws(() => parseGraph({ edges: [["a"]], entries: [] }), /pair/);
  assert.throws(() => parseGraph({ edges: [], entries: [1] }), /string/);
  assert.throws(() => parseGraph(null), /object/);
});

// --- Evidence: exhaustive small-graph path enumeration -------------------

/** Deterministic PRNG (mulberry32) so the check is reproducible. */
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

function randomGraph(rand: () => number, nodeCount: number): SymbolGraph {
  const nodes = Array.from({ length: nodeCount }, (_, i) => `s${i}`);
  const edges: Array<readonly [string, string]> = [];
  for (const from of nodes) {
    for (const to of nodes) {
      if (from !== to && rand() < 0.25) edges.push([from, to]);
    }
  }
  const entries = nodes.filter(() => rand() < 0.4);
  return makeGraph(edges, entries.length > 0 ? entries : [nodes[0]!]);
}

test("reported chains match exhaustive path enumeration on small graphs", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const oldGraph = randomGraph(rng(seed), 5);
    const newGraph = randomGraph(rng(seed * 1000 + 7), 5);
    const report = analyzeImpact(oldGraph, newGraph);

    for (const entry of report.union.entries) {
      // Ground truth: shortest enumerated path from ANY changed symbol.
      let bestLength = Infinity;
      for (const changed of report.changed) {
        for (const path of enumerateImpactPaths(report.union, changed, entry)) {
          bestLength = Math.min(bestLength, path.length);
        }
      }
      const best = bestLength === Infinity ? null : bestLength;

      const impact = report.byEntry.get(entry);
      if (best === null) {
        assert.equal(
          impact,
          undefined,
          `seed ${seed}: entry ${entry} should be unaffected`,
        );
      } else {
        assert.ok(impact, `seed ${seed}: entry ${entry} should be impacted`);
        assert.equal(
          impact.chain.length,
          best,
          `seed ${seed}: chain to ${entry} must be shortest ` +
            `(got ${impact.chain.join("->")}, want length ${best})`,
        );
        // The reported chain must be a real path in the union graph.
        const realPaths = enumerateImpactPaths(
          report.union,
          impact.changed,
          entry,
        ).map((p) => p.join("->"));
        assert.ok(
          realPaths.includes(impact.chain.join("->")),
          `seed ${seed}: ${impact.chain.join("->")} is not a real path`,
        );
      }
    }
  }
});
