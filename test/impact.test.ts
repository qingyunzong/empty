import assert from "node:assert/strict";
import test from "node:test";

import {
  SymbolGraph,
  analyzeImpact,
  enumerateChains,
  shortestChainsToEntries,
  verifyReportByEnumeration,
  type ChangeSet,
} from "../src/index.js";

test("shortest chain per entry is reported", () => {
  const graph = new SymbolGraph();
  graph.addSymbol("entry", { public: true });
  graph.addReference("entry", "mid");
  graph.addReference("mid", "leaf");
  graph.addReference("entry", "longA");
  graph.addReference("longA", "longB");
  graph.addReference("longB", "leaf");

  const report = analyzeImpact(graph, graph, { changed: ["leaf"] });
  assert.equal(report.entries.length, 1);
  assert.deepEqual(report.entries[0], {
    entry: "entry",
    trigger: "leaf",
    chain: ["entry", "mid", "leaf"],
    source: "new",
  });
});

test("direct reference yields a two-node chain", () => {
  const graph = new SymbolGraph();
  graph.addSymbol("api", { public: true });
  graph.addReference("api", "impl");

  const chains = shortestChainsToEntries("impl", graph);
  assert.deepEqual(chains.get("api"), ["api", "impl"]);
});

test("deleted symbols keep their old-graph impact", () => {
  const oldGraph = new SymbolGraph();
  oldGraph.addSymbol("entry", { public: true });
  oldGraph.addReference("entry", "mid");
  oldGraph.addReference("mid", "gone");

  const newGraph = new SymbolGraph();
  newGraph.addSymbol("entry", { public: true });
  newGraph.addReference("entry", "mid");

  const report = analyzeImpact(oldGraph, newGraph, { deleted: ["gone"] });
  assert.equal(report.entries.length, 1);
  assert.deepEqual(report.entries[0], {
    entry: "entry",
    trigger: "gone",
    chain: ["entry", "mid", "gone"],
    source: "old",
  });
});

test("report is the union of old- and new-graph impacts", () => {
  const oldGraph = new SymbolGraph();
  oldGraph.addSymbol("entryOld", { public: true });
  oldGraph.addReference("entryOld", "removed");

  const newGraph = new SymbolGraph();
  newGraph.addSymbol("entryNew", { public: true });
  newGraph.addReference("entryNew", "touched");

  const report = analyzeImpact(oldGraph, newGraph, {
    changed: ["touched"],
    deleted: ["removed"],
  });
  assert.deepEqual(
    report.entries.map((impact) => [impact.entry, impact.source]),
    [
      ["entryNew", "new"],
      ["entryOld", "old"],
    ],
  );
});

test("union merge keeps the shortest chain across both graphs", () => {
  const oldGraph = new SymbolGraph();
  oldGraph.addSymbol("entry", { public: true });
  oldGraph.addReference("entry", "a");
  oldGraph.addReference("a", "b");
  oldGraph.addReference("b", "removed");

  const newGraph = new SymbolGraph();
  newGraph.addSymbol("entry", { public: true });
  newGraph.addReference("entry", "touched");

  const report = analyzeImpact(oldGraph, newGraph, {
    changed: ["touched"],
    deleted: ["removed"],
  });
  assert.equal(report.entries.length, 1);
  assert.deepEqual(report.entries[0]!.chain, ["entry", "touched"]);
  assert.equal(report.entries[0]!.source, "new");
});

test("equal-length chains prefer the new graph", () => {
  const oldGraph = new SymbolGraph();
  oldGraph.addSymbol("entry", { public: true });
  oldGraph.addReference("entry", "removed");

  const newGraph = new SymbolGraph();
  newGraph.addSymbol("entry", { public: true });
  newGraph.addReference("entry", "touched");

  const report = analyzeImpact(oldGraph, newGraph, {
    changed: ["touched"],
    deleted: ["removed"],
  });
  assert.equal(report.entries[0]!.source, "new");
  assert.equal(report.entries[0]!.trigger, "touched");
});

test("symbols unreachable from any public entry produce no impact", () => {
  const graph = new SymbolGraph();
  graph.addSymbol("entry", { public: true });
  graph.addReference("internal", "helper");

  const report = analyzeImpact(graph, graph, { changed: ["helper"] });
  assert.deepEqual(report.entries, []);
});

test("unknown changed symbols are ignored without crashing", () => {
  const graph = new SymbolGraph();
  graph.addSymbol("entry", { public: true });

  const report = analyzeImpact(graph, graph, {
    changed: ["missing"],
    deleted: ["alsoMissing"],
  });
  assert.deepEqual(report.entries, []);
});

test("cycles do not hang and still yield the shortest chain", () => {
  const graph = new SymbolGraph();
  graph.addSymbol("entry", { public: true });
  graph.addReference("entry", "a");
  graph.addReference("a", "b");
  graph.addReference("b", "a");
  graph.addReference("b", "leaf");

  const report = analyzeImpact(graph, graph, { changed: ["leaf"] });
  assert.deepEqual(report.entries[0]!.chain, ["entry", "a", "b", "leaf"]);
});

test("a changed public entry impacts itself", () => {
  const graph = new SymbolGraph();
  graph.addSymbol("entry", { public: true });

  const report = analyzeImpact(graph, graph, { changed: ["entry"] });
  assert.deepEqual(report.entries[0]!.chain, ["entry"]);
});

test("enumerateChains lists every simple path", () => {
  const graph = new SymbolGraph();
  graph.addSymbol("entry", { public: true });
  graph.addReference("entry", "x");
  graph.addReference("entry", "y");
  graph.addReference("x", "leaf");
  graph.addReference("y", "leaf");
  graph.addReference("entry", "leaf");

  const paths = enumerateChains("entry", "leaf", graph);
  assert.equal(paths.length, 3);
  const shortest = paths.reduce((best, path) =>
    path.length < best.length ? path : best,
  );
  assert.deepEqual(shortest, ["entry", "leaf"]);
});

test("enumeration guard rejects oversized graphs", () => {
  const graph = new SymbolGraph();
  graph.addSymbol("entry", { public: true });
  for (let i = 0; i < 6; i += 1) {
    graph.addReference("entry", `b${i}`);
    graph.addReference(`b${i}`, "leaf");
  }
  assert.throws(
    () => enumerateChains("entry", "leaf", graph, { maxPaths: 3 }),
    RangeError,
  );
});

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGraph(rand: () => number, size: number): SymbolGraph {
  const graph = new SymbolGraph();
  for (let i = 0; i < size; i += 1) {
    graph.addSymbol(`s${i}`, { public: rand() < 0.3 });
  }
  for (let from = 0; from < size; from += 1) {
    for (let to = 0; to < size; to += 1) {
      if (from !== to && rand() < 0.18) graph.addReference(`s${from}`, `s${to}`);
    }
  }
  return graph;
}

test("BFS report matches exhaustive enumeration on random small graphs", () => {
  const rand = mulberry32(20261005);
  let totalPairs = 0;
  for (let round = 0; round < 60; round += 1) {
    const oldGraph = randomGraph(rand, 7);
    const newGraph = randomGraph(rand, 7);
    const changes: ChangeSet = {
      changed: oldGraph.symbolIds().filter(() => rand() < 0.4),
      deleted: newGraph.symbolIds().filter(() => rand() < 0.3),
    };
    const report = analyzeImpact(oldGraph, newGraph, changes);
    const verification = verifyReportByEnumeration(
      oldGraph,
      newGraph,
      changes,
      report,
    );
    assert.deepEqual(
      verification.mismatches,
      [],
      `round ${round} mismatches`,
    );
    assert.ok(verification.ok);
    totalPairs += verification.checkedPairs;
  }
  assert.ok(totalPairs > 0, "expected enumeration to check at least one pair");
});

test("hand-built small graph cross-checked by enumeration", () => {
  const oldGraph = new SymbolGraph();
  oldGraph.addSymbol("main", { public: true });
  oldGraph.addSymbol("cli", { public: true });
  oldGraph.addReference("main", "core");
  oldGraph.addReference("cli", "core");
  oldGraph.addReference("core", "util");
  oldGraph.addReference("main", "util");
  oldGraph.addReference("util", "legacy");

  const newGraph = new SymbolGraph();
  newGraph.addSymbol("main", { public: true });
  newGraph.addSymbol("cli", { public: true });
  newGraph.addReference("main", "core");
  newGraph.addReference("cli", "core");
  newGraph.addReference("core", "util");
  newGraph.addReference("main", "util");
  newGraph.addReference("util", "fresh");

  const changes: ChangeSet = { changed: ["fresh", "core"], deleted: ["legacy"] };
  const report = analyzeImpact(oldGraph, newGraph, changes);

  const byEntry = new Map(report.entries.map((impact) => [impact.entry, impact]));
  assert.deepEqual(byEntry.get("main")!.chain, ["main", "core"]);
  assert.deepEqual(byEntry.get("cli")!.chain, ["cli", "core"]);

  const verification = verifyReportByEnumeration(oldGraph, newGraph, changes, report);
  assert.ok(verification.ok);
  assert.deepEqual(verification.mismatches, []);
  assert.ok(verification.checkedPairs >= 6);
});
