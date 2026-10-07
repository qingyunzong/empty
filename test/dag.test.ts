import { test } from "node:test";
import assert from "node:assert/strict";
import { DagScheduler, CycleError, EXIT_NODE } from "../src/dag.js";

function buildDiamond(): DagScheduler {
  // A -> B(3) -> D(4) -> E(2), A -> C(2) -> D(1)
  const g = new DagScheduler();
  g.addEdge("A", "B", 3);
  g.addEdge("A", "C", 2);
  g.addEdge("B", "D", 4);
  g.addEdge("C", "D", 1);
  g.addEdge("D", "E", 2);
  return g;
}

test("earliest/latest start and makespan on a diamond DAG", () => {
  const s = buildDiamond().recompute();
  assert.equal(s.makespan, 9);
  const es = Object.fromEntries(s.earliestStart);
  const ls = Object.fromEntries(s.latestStart);
  assert.deepEqual(es, { A: 0, B: 3, C: 2, D: 7, E: 9 });
  assert.deepEqual(ls, { A: 0, B: 3, C: 6, D: 7, E: 9 });
});

test("critical edges are tight in both ES and LS, exit edge included", () => {
  const critical = buildDiamond()
    .criticalEdges()
    .map((e) => `${e.from}->${e.to}:${e.duration}`)
    .sort();
  assert.deepEqual(critical, ["A->B:3", "B->D:4", "D->E:2", `E->${EXIT_NODE}:0`]);
});

test("multiple sinks share a common zero-duration exit", () => {
  const g = new DagScheduler();
  g.addEdge("A", "B", 5);
  g.addEdge("A", "C", 3);
  const s = g.recompute();
  assert.equal(s.makespan, 5);
  // Both sinks are pinned to the makespan through the virtual exit.
  assert.equal(s.latestStart.get("B"), 5);
  assert.equal(s.latestStart.get("C"), 5); // C has 2 units of slack
  const critical = g.criticalEdges().map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(critical, ["A->B", `B->${EXIT_NODE}`]);
});

test("zero-duration edges are legal and can be critical", () => {
  const g = new DagScheduler();
  g.addEdge("A", "B", 0);
  g.addEdge("B", "C", 0);
  g.addEdge("A", "C", 5);
  const s = g.recompute();
  assert.equal(s.makespan, 5);
  assert.equal(s.earliestStart.get("B"), 0);
  assert.equal(s.latestStart.get("B"), 5); // zero-cost chain carries full slack
  const critical = g.criticalEdges().map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(critical, ["A->C", `C->${EXIT_NODE}`]);

  const h = new DagScheduler();
  h.addEdge("A", "B", 2);
  h.addEdge("B", "C", 0); // zero-duration edge on the critical path
  const criticalH = h.criticalEdges().map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(criticalH, ["A->B", "B->C", `C->${EXIT_NODE}`]);
  assert.equal(h.recompute().makespan, 2);
});

test("longest-path certificate witnesses the makespan", () => {
  const g = buildDiamond();
  const cert = g.longestPathCertificate();
  assert.equal(cert.totalDuration, g.getSchedule().makespan);
  assert.equal(cert.path.at(-1), EXIT_NODE);
  assert.deepEqual(cert.path, ["A", "B", "D", "E", EXIT_NODE]);
  // Every edge on the certificate is critical.
  const critical = new Set(g.criticalEdges().map((e) => `${e.from}->${e.to}`));
  for (let i = 0; i + 1 < cert.path.length; i++) {
    assert.ok(critical.has(`${cert.path[i]}->${cert.path[i + 1]}`));
  }
  // Durations along the path sum to the makespan.
  let sum = 0;
  for (let i = 0; i + 2 < cert.path.length; i++) {
    sum += g.edgeDuration(cert.path[i]!, cert.path[i + 1]!);
  }
  assert.equal(sum, cert.totalDuration);
});

test("incremental update (increase on critical path) matches full recompute", () => {
  const g = buildDiamond();
  g.recompute();
  const { schedule, verification } = g.updateDuration("B", "D", 10);
  assert.equal(schedule.makespan, 15);
  assert.equal(schedule.earliestStart.get("D"), 13);
  assert.ok(verification.consistent, verification.mismatches.join("; "));
});

test("incremental update (increase off critical path) matches full recompute", () => {
  const g = buildDiamond();
  g.recompute();
  const { schedule, verification } = g.updateDuration("C", "D", 10);
  assert.equal(schedule.makespan, 14); // C->D now dominates: 2 + 10 + 2
  assert.equal(schedule.earliestStart.get("D"), 12);
  assert.ok(verification.consistent, verification.mismatches.join("; "));
});

test("incremental update (decrease) matches full recompute", () => {
  const g = buildDiamond();
  g.recompute();
  const r1 = g.updateDuration("B", "D", 1);
  assert.equal(r1.schedule.makespan, 6); // A->B->D = 4 no longer dominates... A,C,D = 3? B path: 3+1=4, C path: 2+1=3 -> D=4, E=6
  assert.ok(r1.verification.consistent, r1.verification.mismatches.join("; "));
  const r2 = g.updateDuration("A", "B", 0); // shrink to zero duration
  assert.equal(r2.schedule.makespan, 5); // D = max(0+1, 2+1) = 3, E = 5
  assert.ok(r2.verification.consistent, r2.verification.mismatches.join("; "));
  // Certificate must still witness the new makespan after incremental updates.
  const cert = g.longestPathCertificate();
  assert.equal(cert.totalDuration, g.getSchedule().makespan);
});

test("chained incremental updates stay consistent with full recompute", () => {
  const g = buildDiamond();
  const updates: Array<[string, string, number]> = [
    ["A", "B", 7],
    ["D", "E", 0],
    ["A", "C", 4],
    ["C", "D", 6],
    ["B", "D", 2],
  ];
  for (const [u, v, w] of updates) {
    const { verification } = g.updateDuration(u, v, w);
    assert.ok(verification.consistent, `${u}->${v}=${w}: ${verification.mismatches.join("; ")}`);
  }
  assert.equal(g.getSchedule().makespan, g.recompute().makespan);
});

test("updateDuration validates inputs", () => {
  const g = buildDiamond();
  assert.throws(() => g.updateDuration("B", "D", -1), />= 0/);
  assert.throws(() => g.updateDuration("X", "Y", 1), /No edge/);
  assert.throws(() => g.addEdge("A", "B", Number.NaN), />= 0/);
});

test("cyclic graph reports the shortest cycle", () => {
  const g = new DagScheduler();
  g.addEdge("A", "B", 1);
  g.addEdge("B", "C", 1);
  g.addEdge("C", "A", 1); // 3-cycle
  g.addEdge("D", "E", 1);
  g.addEdge("E", "D", 1); // 2-cycle, the shortest
  const cycle = g.shortestCycle();
  assert.ok(cycle);
  assert.equal(cycle!.length, 3); // [D, E, D] or [E, D, E]
  assert.equal(cycle![0], cycle!.at(-1));
  assert.throws(() => g.recompute(), CycleError);
  try {
    g.recompute();
    assert.ok(false, "should have thrown");
  } catch (err) {
    assert.ok(err instanceof CycleError);
    if (err instanceof CycleError) {
      assert.deepEqual(err.cycle, cycle);
      assert.match(err.message, /shortest cycle/);
    }
  }
});

test("self-loop is a cycle of length 1", () => {
  const g = new DagScheduler();
  g.addEdge("A", "A", 0);
  assert.deepEqual(g.shortestCycle(), ["A", "A"]);
  assert.throws(() => g.recompute(), CycleError);
});

test("updateDuration on a cyclic graph throws CycleError", () => {
  const g = new DagScheduler();
  g.addEdge("A", "B", 1);
  g.addEdge("B", "A", 1);
  assert.throws(() => g.updateDuration("A", "B", 2), CycleError);
});

test("empty and single-node graphs", () => {
  const g = new DagScheduler();
  assert.equal(g.recompute().makespan, 0);
  assert.deepEqual(g.longestPathCertificate(), { path: [EXIT_NODE], totalDuration: 0 });
  g.addNode("solo");
  const s = g.recompute();
  assert.equal(s.makespan, 0);
  assert.equal(s.earliestStart.get("solo"), 0);
  assert.equal(s.latestStart.get("solo"), 0);
});
