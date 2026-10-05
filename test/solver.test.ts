import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { normalize, Problem } from "../src/types";
import { checkFeasible, enumerateAll, groupClosure, solve } from "../src/solver";
import { buildReport } from "../src/certify";
import { verifyReport } from "../src/verify";
import { findCycle, topoOrder } from "../src/graph";

function solveProblem(raw: Problem) {
  const p = normalize(raw);
  const result = solve(p);
  return { p, result, report: buildReport(p, result) };
}

test("simple cycle: cheapest edge removed, topo order and certificates emitted", () => {
  const { report } = solveProblem({
    edges: [
      { id: "e1", from: "a", to: "b", cost: 5 },
      { id: "e2", from: "b", to: "c", cost: 2 },
      { id: "e3", from: "c", to: "a", cost: 4 },
    ],
  });
  equal(report.status, "optimal");
  equal(report.cost, 2);
  deepEqual(report.deletedEdges!.map((d) => d.id), ["e2"]);
  // remaining edges: a->b and c->a, so the only valid order is c,a,b
  deepEqual(report.topologicalOrder, ["c", "a", "b"]);
  equal(report.deletedEdges![0]!.reason, "breaks-cycle");
  deepEqual(report.deletedEdges![0]!.witnessCycle, ["b", "c", "a", "b"]);
  equal(report.optimalityProof!.methodsAgree, true);
});

test("reachability constraint forbids the cheapest repair", () => {
  const { report } = solveProblem({
    edges: [
      { id: "e1", from: "a", to: "b", cost: 5 },
      { id: "e2", from: "b", to: "c", cost: 2 },
      { id: "e3", from: "c", to: "a", cost: 4 },
      { id: "e4", from: "c", to: "d", cost: 1, locked: true },
    ],
    reachability: [{ from: "a", to: "d" }],
  });
  equal(report.status, "optimal");
  equal(report.cost, 4); // e2 (cost 2) would break a->d
  deepEqual(report.deletedEdges!.map((d) => d.id), ["e3"]);
  deepEqual(report.reachabilityCertificates![0]!.nodes, ["a", "b", "c", "d"]);
});

test("locked cycle makes the problem infeasible and is reported", () => {
  const { report } = solveProblem({
    edges: [
      { id: "x1", from: "a", to: "b", cost: 1, locked: true },
      { id: "x2", from: "b", to: "c", cost: 1, locked: true },
      { id: "x3", from: "c", to: "a", cost: 1, locked: true },
      { id: "x4", from: "a", to: "c", cost: 9 },
    ],
  });
  equal(report.status, "infeasible");
  equal(report.infeasibility!.kind, "locked-cycle");
  deepEqual(report.infeasibility!.undeletableCycle, ["a", "b", "c", "a"]);
});

test("budget below minimum cost is diagnosed", () => {
  const { report } = solveProblem({
    edges: [
      { id: "e1", from: "a", to: "b", cost: 7 },
      { id: "e2", from: "b", to: "a", cost: 8 },
    ],
    budget: 3,
  });
  equal(report.status, "infeasible");
  equal(report.infeasibility!.kind, "budget");
  equal(report.infeasibility!.minCostWithoutBudget, 7);
});

test("group prerequisite closure forces extra deletions", () => {
  const p = normalize({
    edges: [
      { id: "e1", from: "a", to: "b", cost: 1, group: "g1" },
      { id: "e2", from: "b", to: "a", cost: 9 },
      { id: "e3", from: "a", to: "c", cost: 1, group: "g2" },
    ],
    groups: { g1: { requires: ["g2"] } },
  });
  // deleting e1 (group g1) forces deleting e3 (group g2)
  equal(groupClosure(p, 0b001), 0b101);
  const { report } = solveProblem({
    edges: [
      { id: "e1", from: "a", to: "b", cost: 1, group: "g1" },
      { id: "e2", from: "b", to: "a", cost: 9 },
      { id: "e3", from: "a", to: "c", cost: 1, group: "g2" },
    ],
    groups: { g1: { requires: ["g2"] } },
  });
  equal(report.status, "optimal");
  equal(report.cost, 2);
  const forced = report.deletedEdges!.find((d) => d.id === "e3")!;
  equal(forced.reason, "group-prerequisite");
  equal(forced.forcedBy!.edge, "e1");
  deepEqual(forced.forcedBy!.chain, ["g1", "g2"]);
});

test("group closure hitting a locked edge forbids that deletion", () => {
  const { report } = solveProblem({
    edges: [
      { id: "e1", from: "a", to: "b", cost: 1, group: "g1" },
      { id: "e2", from: "b", to: "a", cost: 9 },
      { id: "e3", from: "a", to: "c", cost: 1, group: "g2", locked: true },
    ],
    groups: { g1: { requires: ["g2"] } },
  });
  equal(report.status, "optimal");
  equal(report.cost, 9); // e1 is forbidden, must delete expensive e2
  deepEqual(report.deletedEdges!.map((d) => d.id), ["e2"]);
});

test("reachability impossible in the original graph is diagnosed", () => {
  const { report } = solveProblem({
    edges: [{ id: "e1", from: "a", to: "b", cost: 1 }],
    reachability: [{ from: "b", to: "a" }],
  });
  equal(report.status, "infeasible");
  equal(report.infeasibility!.kind, "reachability");
});

test("more than 18 edges is rejected", () => {
  const edges = Array.from({ length: 19 }, (_, i) => ({
    id: `e${i}`,
    from: `n${i}`,
    to: `n${i + 1}`,
    cost: 1,
  }));
  throws(() => normalize({ edges }), /too many edges/);
});

test("exactly 18 edges is accepted and solved", () => {
  // 9 disjoint 2-cycles = 18 edges
  const edges = Array.from({ length: 9 }, (_, i) => [
    { id: `a${i}`, from: `u${i}`, to: `v${i}`, cost: i + 1 },
    { id: `b${i}`, from: `v${i}`, to: `u${i}`, cost: 10 + i },
  ]).flat();
  const { report } = solveProblem({ edges });
  equal(report.status, "optimal");
  equal(report.cost, 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9);
  deepEqual(report.deletedEdges!.map((d) => d.id), Array.from({ length: 9 }, (_, i) => `a${i}`));
  equal(report.optimalityProof!.methodsAgree, true);
});

test("verifier accepts a genuine report and rejects tampering", () => {
  const problem: Problem = {
    edges: [
      { id: "e1", from: "a", to: "b", cost: 5 },
      { id: "e2", from: "b", to: "c", cost: 2 },
      { id: "e3", from: "c", to: "a", cost: 4 },
    ],
    reachability: [{ from: "a", to: "c" }],
  };
  const { p, report } = solveProblem(problem);
  const good = verifyReport(p, report);
  ok(good.ok, JSON.stringify(good.checks));
  const badCost = verifyReport(p, { ...report, cost: 1 });
  ok(!badCost.ok);
  const badTopo = verifyReport(p, { ...report, topologicalOrder: ["c", "b", "a"] });
  ok(!badTopo.ok);
  const noDelete = verifyReport(p, { ...report, cost: 0, deletedEdges: [] });
  ok(!noDelete.ok);
});

test("verifier confirms infeasible reports", () => {
  const { p, report } = solveProblem({
    edges: [
      { id: "x1", from: "a", to: "b", cost: 1, locked: true },
      { id: "x2", from: "b", to: "a", cost: 1, locked: true },
    ],
  });
  equal(report.status, "infeasible");
  const res = verifyReport(p, report);
  ok(res.ok, JSON.stringify(res.checks));
});

// deterministic PRNG for the randomized cross-check
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("random graphs: branch&bound always agrees with exhaustive enumeration", () => {
  const rnd = mulberry32(42);
  for (let trial = 0; trial < 60; trial++) {
    const nodeCount = 3 + Math.floor(rnd() * 4);
    const nodes = Array.from({ length: nodeCount }, (_, i) => `n${i}`);
    const edgeCount = 2 + Math.floor(rnd() * 11); // up to 12 edges
    const groups = ["g1", "g2"];
    const useGroups = rnd() < 0.4;
    const edges = Array.from({ length: edgeCount }, (_, i) => ({
      id: `e${i}`,
      from: nodes[Math.floor(rnd() * nodeCount)]!,
      to: nodes[Math.floor(rnd() * nodeCount)]!,
      cost: 1 + Math.floor(rnd() * 9),
      locked: rnd() < 0.15,
      group: useGroups && (rnd() < 0.4 || i < 2) ? groups[i % 2]! : undefined,
    }));
    const problem: Problem = {
      edges,
      budget: rnd() < 0.5 ? 5 + Math.floor(rnd() * 20) : undefined,
      reachability:
        rnd() < 0.5
          ? [{ from: nodes[Math.floor(rnd() * nodeCount)]!, to: nodes[Math.floor(rnd() * nodeCount)]! }]
          : undefined,
      groups: useGroups ? { g1: { requires: ["g2"] } } : undefined,
    };
    const p = normalize(problem);
    const r = solve(p);
    ok(r.agree, `trial ${trial}: enum=${r.enumeration.bestCost} bnb=${r.branchAndBound.bestCost}`);
    const report = buildReport(p, r);
    const v = verifyReport(p, report);
    ok(v.ok, `trial ${trial} verify: ${JSON.stringify(v.checks.filter((c) => !c.ok))}`);
    if (r.feasible) {
      const f = checkFeasible(p, r.bestMask);
      ok(f.ok, `trial ${trial} feasibility`);
    }
  }
});

test("topoOrder returns null exactly on cyclic graphs", () => {
  const cyclic = normalize({
    edges: [
      { id: "e1", from: "a", to: "b", cost: 1 },
      { id: "e2", from: "b", to: "a", cost: 1 },
    ],
  });
  equal(topoOrder(cyclic, () => true), null);
  deepEqual(findCycle(cyclic, () => true), ["a", "b", "a"]);
  const acyclic = normalize({
    edges: [
      { id: "e1", from: "a", to: "b", cost: 1 },
      { id: "e2", from: "a", to: "c", cost: 1 },
    ],
  });
  deepEqual(topoOrder(acyclic, () => true), ["a", "b", "c"]);
});

test("enumeration evaluates each closed deletion set exactly once", () => {
  const p = normalize({
    edges: [
      { id: "e1", from: "a", to: "b", cost: 1, group: "g1" },
      { id: "e2", from: "c", to: "d", cost: 1, group: "g2" },
    ],
    groups: { g1: { requires: ["g2"] } },
  });
  // closed sets: {} and {e1,e2} and {e2} -> 3 candidates, not 4
  const en = enumerateAll(p);
  equal(en.checked, 3);
});
