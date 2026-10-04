import { test } from "node:test";
import assert from "node:assert/strict";
import { FixtureStore } from "../src/store";
import {
  applyEdits,
  collectNodes,
  mulberry32,
  randomEdits,
  randomGraph,
  refDeepCopy,
  refEqual,
} from "./model";

type AnyObj = Record<string, any>;

function assertDeepFrozen(root: unknown): void {
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (typeof v !== "object" || v === null || seen.has(v)) return;
    seen.add(v);
    assert.ok(Object.isFrozen(v), "expected object to be frozen");
    for (const k of Object.keys(v)) walk((v as AnyObj)[k]);
  };
  walk(root);
}

test("baseline is immutable (deep-frozen)", () => {
  const shared = { n: 1 };
  const root = { a: shared, b: shared, list: [1, 2, { z: 3 }] };
  const store = new FixtureStore(root);
  assertDeepFrozen(store.baseline);
  assert.throws(() => {
    (store.baseline as AnyObj).a.n = 99;
  }, TypeError);
  assert.equal((store.baseline as AnyObj).a.n, 1);
});

test("fork preserves aliases and cycles; matches reference deep copy", () => {
  const shared = { v: 1 };
  const root: AnyObj = { a: shared, b: shared };
  root.self = root;
  const store = new FixtureStore(root);
  const branch = store.fork();
  const working = branch.working as AnyObj;

  assert.equal(working.a, working.b, "alias must stay aliased");
  assert.equal(working.self, working, "cycle must point at the clone root");
  assert.notEqual(working.a, (store.baseline as AnyObj).a);
  assert.ok(refEqual(working, refDeepCopy(root)));
});

test("branch writes do not pollute the baseline", () => {
  const root: AnyObj = { keep: { x: 1 }, arr: [1, 2] };
  root.loop = root;
  const snapshot = refDeepCopy(root);
  const store = new FixtureStore(root);
  const branch = store.fork();
  const working = branch.working as AnyObj;

  working.keep.x = 100;
  working.added = "branch-only";
  working.arr.push(3);
  delete working.loop.loop;

  assert.ok(refEqual(store.baseline, snapshot), "baseline must be untouched");
  assert.equal((store.baseline as AnyObj).keep.x, 1);
  assert.equal((store.baseline as AnyObj).added, undefined);
});

test("merge combines disjoint changes from two branches", () => {
  const store = new FixtureStore({ p: 1, q: 2, nested: { x: "a", y: "b" } });
  const b1 = store.fork();
  const b2 = store.fork();
  (b1.working as AnyObj).p = 10;
  (b1.working as AnyObj).nested.x = "A";
  (b2.working as AnyObj).q = 20;
  (b2.working as AnyObj).nested.y = "B";

  const r1 = store.merge(b1);
  assert.ok(r1.ok);
  const r2 = store.merge(b2);
  assert.ok(r2.ok);

  const baseline = store.baseline as AnyObj;
  assert.deepEqual(baseline, { p: 10, q: 20, nested: { x: "A", y: "B" } });
  assertDeepFrozen(store.baseline);
});

test("conflicting writes to the same field are reported, baseline untouched", () => {
  const store = new FixtureStore({ a: { x: 1 }, other: 0 });
  const b1 = store.fork();
  const b2 = store.fork();
  (b1.working as AnyObj).a.x = 2;
  (b2.working as AnyObj).a.x = 3;

  assert.ok(store.merge(b1).ok);
  const before = store.baseline;
  const r2 = store.merge(b2);
  assert.equal(r2.ok, false);
  if (!r2.ok) {
    assert.equal(r2.conflicts.length, 1);
    assert.equal(r2.conflicts[0].path, "$.a.x");
    assert.equal(r2.conflicts[0].base, 1);
    assert.equal(r2.conflicts[0].ours, 2);
    assert.equal(r2.conflicts[0].theirs, 3);
  }
  assert.equal(store.baseline, before, "failed merge must not change baseline");
});

test("identical writes on both sides are not a conflict", () => {
  const store = new FixtureStore({ x: 1 });
  const b1 = store.fork();
  const b2 = store.fork();
  (b1.working as AnyObj).x = 7;
  (b2.working as AnyObj).x = 7;
  assert.ok(store.merge(b1).ok);
  const r = store.merge(b2);
  assert.ok(r.ok);
  assert.equal((store.baseline as AnyObj).x, 7);
});

test("delete vs modify conflicts; delete vs delete merges", () => {
  const store = new FixtureStore({ doomed: 1, kept: 2 });
  const b1 = store.fork();
  const b2 = store.fork();
  delete (b1.working as AnyObj).doomed;
  (b2.working as AnyObj).doomed = 5;

  assert.ok(store.merge(b1).ok);
  const r = store.merge(b2);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.conflicts[0].path, "$.doomed");

  const store2 = new FixtureStore({ doomed: 1, kept: 2 });
  const c1 = store2.fork();
  const c2 = store2.fork();
  delete (c1.working as AnyObj).doomed;
  delete (c2.working as AnyObj).doomed;
  assert.ok(store2.merge(c1).ok);
  assert.ok(store2.merge(c2).ok);
  assert.deepEqual(store2.baseline, { kept: 2 });
});

test("arrays merge element-wise: push on one side, edit on the other", () => {
  const store = new FixtureStore({ list: [1, 2, 3] });
  const b1 = store.fork();
  const b2 = store.fork();
  (b1.working as AnyObj).list.push(4);
  (b2.working as AnyObj).list[0] = 100;
  assert.ok(store.merge(b1).ok);
  assert.ok(store.merge(b2).ok);
  assert.deepEqual(store.baseline, { list: [100, 2, 3, 4] });
});

test("stable ids, aliases and cycles survive fork and merge", () => {
  const shared = { v: 1 };
  const root: AnyObj = { a: shared, b: shared };
  root.self = root;
  const store = new FixtureStore(root);

  const baselineRoot = store.baseline as AnyObj;
  const idRoot = store.idOf(baselineRoot);
  const idShared = store.idOf(baselineRoot.a);
  assert.equal(store.idOf(baselineRoot.a), store.idOf(baselineRoot.b));

  const branch = store.fork();
  const working = branch.working as AnyObj;
  assert.equal(store.idOf(working), idRoot, "fork clone keeps root id");
  assert.equal(store.idOf(working.a), idShared, "fork clone keeps node id");

  working.a.v = 42;
  const result = store.merge(branch);
  assert.ok(result.ok);

  const merged = store.baseline as AnyObj;
  assert.equal(merged.a, merged.b, "alias preserved through merge");
  assert.equal(merged.self, merged, "cycle preserved through merge");
  assert.equal(merged.a.v, 42);
  assert.equal(store.idOf(merged), idRoot, "root id stable across merge");
  assert.equal(store.idOf(merged.a), idShared, "node id stable across merge");
});

test("merging a cyclic edit through an alias updates every path", () => {
  const node: AnyObj = { name: "n" };
  const left = { ref: node };
  const right = { ref: node };
  node.back = left;
  const store = new FixtureStore({ left, right });

  const branch = store.fork();
  (branch.working as AnyObj).right.ref.name = "renamed";
  assert.ok(store.merge(branch).ok);

  const merged = store.baseline as AnyObj;
  assert.equal(merged.left.ref, merged.right.ref);
  assert.equal(merged.left.ref.name, "renamed");
  assert.equal(merged.left.ref.back, merged.left);
});

test("randomized: merges of random graphs match the deep-copy reference model", () => {
  const ITERATIONS = 200;
  for (let i = 0; i < ITERATIONS; i++) {
    const rand = mulberry32(1000 + i);
    const { root } = randomGraph(rand);

    const reference = refDeepCopy(root);
    const refNodes = collectNodes(reference);

    const store = new FixtureStore(root);
    const baselineSnapshot = refDeepCopy(root);

    const editsA = randomEdits(rand, refNodes.length, "ea", 1 + Math.floor(rand() * 5));
    const editsB = randomEdits(rand, refNodes.length, "eb", 1 + Math.floor(rand() * 5));

    const branchA = store.fork();
    const branchB = store.fork();
    applyEdits(collectNodes(branchA.working as AnyObj), editsA);
    applyEdits(collectNodes(branchB.working as AnyObj), editsB);

    // Branch writes must not leak into the baseline or the other branch.
    assert.ok(refEqual(store.baseline, baselineSnapshot), `iteration ${i}: baseline polluted`);
    const expectedB = refDeepCopy(root);
    applyEdits(collectNodes(expectedB), editsB);
    assert.ok(refEqual(branchB.working, expectedB), `iteration ${i}: cross-branch leak`);

    const r1 = store.merge(branchA);
    assert.ok(r1.ok, `iteration ${i}: disjoint merge A should succeed`);
    const r2 = store.merge(branchB);
    assert.ok(r2.ok, `iteration ${i}: disjoint merge B should succeed`);

    applyEdits(refNodes, editsA);
    applyEdits(refNodes, editsB);
    assert.ok(
      refEqual(store.baseline, reference),
      `iteration ${i}: merged baseline differs from reference model`,
    );
    assertDeepFrozen(store.baseline);
  }
});

test("randomized: same-field different-value edits always conflict", () => {
  const ITERATIONS = 100;
  for (let i = 0; i < ITERATIONS; i++) {
    const rand = mulberry32(5000 + i);
    const store = new FixtureStore({ x: 0, y: { z: "base" } });
    const b1 = store.fork();
    const b2 = store.fork();
    const v1 = Math.floor(rand() * 1000);
    const v2 = v1 + 1 + Math.floor(rand() * 1000);
    (b1.working as AnyObj).y.z = v1;
    (b2.working as AnyObj).y.z = v2;
    assert.ok(store.merge(b1).ok);
    const r = store.merge(b2);
    assert.equal(r.ok, false, `iteration ${i}: expected conflict`);
    if (!r.ok) {
      assert.equal(r.conflicts.length, 1);
      assert.equal(r.conflicts[0].path, "$.y.z");
      assert.equal(r.conflicts[0].ours, v1);
      assert.equal(r.conflicts[0].theirs, v2);
    }
  }
});

test("randomized: cyclic random graphs keep topology through fork+merge", () => {
  const ITERATIONS = 200;
  for (let i = 0; i < ITERATIONS; i++) {
    const rand = mulberry32(9000 + i);
    const { root, nodes } = randomGraph(rand);
    const store = new FixtureStore(root);

    const branch = store.fork();
    const workingNodes = collectNodes(branch.working as AnyObj);
    assert.equal(workingNodes.length, nodes.length, `iteration ${i}: node count`);
    for (let n = 0; n < nodes.length; n++) {
      assert.equal(
        store.idOf(workingNodes[n]),
        store.idOf(collectNodes(store.baseline as AnyObj)[n]),
        `iteration ${i}: stable id for node ${n}`,
      );
    }

    // Point a random node back at the root (add a cycle) and rename a field.
    const working = branch.working as AnyObj;
    workingNodes[0].__cycle = working;
    const r = store.merge(branch);
    assert.ok(r.ok, `iteration ${i}: merge with new cycle`);
    const merged = store.baseline as AnyObj;
    const mergedNodes = collectNodes(merged);
    assert.equal(mergedNodes[0].__cycle, merged, `iteration ${i}: cycle target is merged root`);
    assert.ok(refEqual(merged, branch.working), `iteration ${i}: merged graph equals branch work`);
  }
});
