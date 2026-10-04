import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDag } from "../src/dag.js";
import { fromMap, withFailures } from "../src/oracle.js";
import { findBoundary } from "../src/bisect.js";
import { scanFullDag, crossCheck } from "../src/verify.js";

test("linear chain with monotonic failure finds the first bad version", async () => {
  const dag = buildDag({ edges: [["a", "b"], ["b", "c"], ["c", "d"]] });
  const oracle = fromMap({ a: "good", b: "good", c: "bad", d: "bad" });
  const report = await findBoundary(dag, oracle, 10);
  assert.deepEqual(report.confirmedBoundary, ["c"]);
  assert.deepEqual(report.unresolvedBoundary, []);
  assert.equal(report.complete, true);
  assert.equal(report.queriesUsed, 4);
});

test("non-monotonic results yield multiple boundary versions", async () => {
  const dag = buildDag({ edges: [["a", "b"], ["b", "c"], ["c", "d"]] });
  const oracle = fromMap({ a: "good", b: "bad", c: "good", d: "bad" });
  const report = await findBoundary(dag, oracle, 10);
  assert.deepEqual(report.confirmedBoundary, ["b", "d"]);
});

test("bad version with a bad parent is not on the boundary", async () => {
  const dag = buildDag({ edges: [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]] });
  const oracle = fromMap({ a: "good", b: "bad", c: "good", d: "bad" });
  const report = await findBoundary(dag, oracle, 10);
  assert.deepEqual(report.confirmedBoundary, ["b"]);
});

test("root versions have no parents and are boundary when bad", async () => {
  const dag = buildDag({ edges: [["a", "b"]] });
  const oracle = fromMap({ a: "bad", b: "good" });
  const report = await findBoundary(dag, oracle, 10);
  assert.deepEqual(report.confirmedBoundary, ["a"]);
});

test("detector exceptions become pending and block confirmation downstream", async () => {
  const dag = buildDag({ edges: [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]] });
  const oracle = fromMap({ a: "good", b: "error", c: "good", d: "bad" });
  const report = await findBoundary(dag, oracle, 10);
  assert.equal(report.status.b, "pending");
  assert.deepEqual(report.confirmedBoundary, []);
  assert.deepEqual(report.unresolvedBoundary, ["d"]);
  assert.equal(report.complete, false);
  const errorRecord = report.evidence.find((record) => record.version === "b");
  assert.equal(errorRecord?.outcome, "error");
  assert.match(errorRecord?.error ?? "", /scripted detector failure/);
});

test("budget exhaustion keeps the untested set and a prefix-closed tested set", async () => {
  const dag = buildDag({ edges: [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"]] });
  const oracle = fromMap({ a: "good", b: "good", c: "bad", d: "bad", e: "good" });
  const report = await findBoundary(dag, oracle, 2);
  assert.equal(report.queriesUsed, 2);
  assert.deepEqual(report.untested, ["c", "d", "e"]);
  assert.deepEqual(Object.keys(report.status), ["a", "b"]);
  for (const version of Object.keys(report.status)) {
    for (const parent of dag.parents.get(version) ?? []) {
      assert.ok(parent in report.status, `parent ${parent} of tested ${version} must be tested`);
    }
  }
  assert.equal(report.complete, false);
});

test("zero budget tests nothing", async () => {
  const dag = buildDag({ edges: [["a", "b"]] });
  const oracle = fromMap({ a: "good", b: "bad" });
  const report = await findBoundary(dag, oracle, 0);
  assert.equal(report.queriesUsed, 0);
  assert.deepEqual(report.untested, ["a", "b"]);
  assert.deepEqual(report.confirmedBoundary, []);
  assert.deepEqual(report.evidence, []);
});

test("evidence records queries in topological order", async () => {
  const dag = buildDag({ nodes: ["c", "a", "b"], edges: [["a", "b"], ["b", "c"]] });
  const oracle = fromMap({ a: "good", b: "good", c: "bad" });
  const report = await findBoundary(dag, oracle, 10);
  assert.deepEqual(report.evidence.map((record) => record.version), ["a", "b", "c"]);
  assert.deepEqual(report.evidence.map((record) => record.seq), [1, 2, 3]);
});

test("full-DAG scan agrees with bounded run when budget covers all nodes", async () => {
  const dag = buildDag({ edges: [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"], ["d", "e"]] });
  const oracle = fromMap({ a: "good", b: "bad", c: "good", d: "good", e: "bad" });
  const bounded = await findBoundary(dag, oracle, 100);
  const full = await scanFullDag(dag, oracle);
  assert.deepEqual(bounded.confirmedBoundary, ["b", "e"]);
  assert.deepEqual(full.boundary, bounded.confirmedBoundary);
  const check = crossCheck(dag, bounded, full);
  assert.equal(check.ok, true);
  assert.deepEqual(check.issues, []);
});

test("cross-check explains misses caused by budget and pending", async () => {
  const dag = buildDag({ edges: [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"]] });
  const oracle = fromMap({ a: "good", b: "error", c: "bad", d: "good", e: "bad" });
  const bounded = await findBoundary(dag, oracle, 3);
  const full = await scanFullDag(dag, oracle);
  assert.deepEqual(full.boundary, ["e"]);
  const check = crossCheck(dag, bounded, full);
  assert.equal(check.ok, true);
  assert.deepEqual(check.explainedMisses, [{ version: "e", reason: "untested" }]);
});

test("cross-check flags unexplained misses", async () => {
  const dag = buildDag({ edges: [["a", "b"]] });
  const oracle = fromMap({ a: "good", b: "bad" });
  const bounded = await findBoundary(dag, oracle, 10);
  bounded.confirmedBoundary.length = 0;
  const full = await scanFullDag(dag, oracle);
  const check = crossCheck(dag, bounded, full);
  assert.equal(check.ok, false);
  assert.deepEqual(check.issues.map((issue) => issue.kind), ["unexplained-miss"]);
});

test("cross-check flags false positives against full-DAG truth", async () => {
  const dag = buildDag({ edges: [["a", "b"]] });
  const oracle = fromMap({ a: "good", b: "bad" });
  const bounded = await findBoundary(dag, oracle, 10);
  bounded.confirmedBoundary.push("a");
  const full = await scanFullDag(dag, oracle);
  const check = crossCheck(dag, bounded, full);
  assert.equal(check.ok, false);
  assert.ok(check.issues.some((issue) => issue.kind === "false-positive"));
});

test("withFailures adapter marks flaky versions pending", async () => {
  const dag = buildDag({ edges: [["a", "b"], ["b", "c"]] });
  const base = fromMap({ a: "good", b: "bad", c: "good" });
  const flaky = withFailures(base, (version) => version === "b");
  const report = await findBoundary(dag, flaky, 10);
  assert.equal(report.status.b, "pending");
  assert.deepEqual(report.confirmedBoundary, []);
});

test("buildDag rejects cycles and self-loops", () => {
  assert.throws(() => buildDag({ edges: [["a", "b"], ["b", "a"]] }), /cycle detected/);
  assert.throws(() => buildDag({ edges: [["a", "a"]] }), /self-loop/);
});

test("seeded random DAGs: bounded run with full budget matches full scan", async () => {
  let state = 42;
  const rand = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  for (let trial = 0; trial < 20; trial += 1) {
    const count = 5 + Math.floor(rand() * 15);
    const ids = Array.from({ length: count }, (_, i) => `v${i}`);
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        if (rand() < 0.25) edges.push([ids[i]!, ids[j]!]);
      }
    }
    const script: Record<string, "good" | "bad" | "error"> = {};
    for (const id of ids) {
      const roll = rand();
      script[id] = roll < 0.1 ? "error" : roll < 0.5 ? "bad" : "good";
    }
    const dag = buildDag({ nodes: ids, edges });
    const oracle = fromMap(script);
    const bounded = await findBoundary(dag, oracle, count);
    const full = await scanFullDag(dag, oracle);
    assert.deepEqual(bounded.confirmedBoundary, full.boundary, `trial ${trial}`);
    const check = crossCheck(dag, bounded, full);
    assert.equal(check.ok, true, `trial ${trial}: ${JSON.stringify(check.issues)}`);
  }
});
