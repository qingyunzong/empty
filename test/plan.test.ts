import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPlan,
  invertOp,
  invertPlan,
  mergeManifests,
  revertPlan,
} from "../src/index.js";
import type { Artifact, PlanOp } from "../src/index.js";

const art = (id: string, path: string, digest: string): Artifact => ({ id, path, digest });

test("plan: applying the plan to the ancestor yields the merged manifest", () => {
  const ancestor = [art("K", "/keep", "dk"), art("G", "/gone", "dg"), art("M", "/old", "dm")];
  const ours = [art("K", "/keep", "dk"), art("M", "/new", "dm")];
  const theirs = [art("K", "/keep", "dk"), art("M", "/old", "dm"), art("N", "/added", "dn")];
  const { merged, conflicts, plan } = mergeManifests(ancestor, ours, theirs);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(applyPlan(ancestor, plan), merged);
});

test("plan: reverting the merged manifest restores the ancestor (reversible)", () => {
  const ancestor = [art("K", "/keep", "dk"), art("G", "/gone", "dg"), art("M", "/old", "dm")];
  const ours = [art("K", "/keep", "dk"), art("M", "/new", "dm")];
  const theirs = [art("K", "/keep", "dk"), art("M", "/old", "dm"), art("N", "/added", "dn")];
  const { merged, plan } = mergeManifests(ancestor, ours, theirs);
  assert.deepEqual(revertPlan(merged, plan), [...ancestor].sort((x, y) => x.id.localeCompare(y.id)));
});

test("plan: invertOp is an involution for every op kind", () => {
  const ops: PlanOp[] = [
    { op: "add", artifact: art("A", "/a", "d1") },
    { op: "remove", id: "A", previous: art("A", "/a", "d1") },
    { op: "move", id: "A", from: "/a", to: "/b" },
    { op: "update", id: "A", from: art("A", "/a", "d1"), to: art("A", "/a", "d2") },
  ];
  for (const op of ops) {
    assert.deepEqual(invertOp(invertOp(op)), op);
  }
});

test("plan: invertPlan reverses order and each op", () => {
  const plan: PlanOp[] = [
    { op: "remove", id: "G", previous: art("G", "/gone", "dg") },
    { op: "move", id: "M", from: "/old", to: "/new" },
  ];
  assert.deepEqual(invertPlan(plan), [
    { op: "move", id: "M", from: "/new", to: "/old" },
    { op: "add", artifact: art("G", "/gone", "dg") },
  ]);
});

test("plan: applyPlan rejects ops against missing ids", () => {
  assert.throws(() => applyPlan([], [{ op: "remove", id: "X", previous: art("X", "/x", "d") }]), /not present/);
  assert.throws(() => applyPlan([], [{ op: "move", id: "X", from: "/x", to: "/y" }]), /not present/);
  assert.throws(
    () => applyPlan([], [{ op: "update", id: "X", from: art("X", "/x", "d"), to: art("X", "/x", "e") }]),
    /not present/,
  );
});

test("plan: applyPlan rejects adding an existing id", () => {
  const a = art("A", "/a", "d1");
  assert.throws(() => applyPlan([a], [{ op: "add", artifact: a }]), /already present/);
});
