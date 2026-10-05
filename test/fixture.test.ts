import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { FixtureLibrary, Snapshot } from "../src/fixture";
import { referenceDeepClone, signature, collectObjects } from "./reference";
import { mulberry32, randomGraph, randomMutations, applyMutations } from "./random";

describe("immutable baseline", () => {
  it("snapshot node table is frozen", () => {
    const lib = new FixtureLibrary();
    const snap = lib.commit({ a: 1, nested: { b: 2 } });
    assert.ok(Object.isFrozen(snap));
    for (const node of snap.nodes.values()) {
      assert.ok(Object.isFrozen(node));
      if (node.kind === "record") assert.ok(Object.isFrozen(node.fields));
      if (node.kind === "array") assert.ok(Object.isFrozen(node.items));
    }
  });

  it("branch writes do not pollute the baseline", () => {
    const lib = new FixtureLibrary();
    const original = { user: { name: "ada", tags: ["x"] }, count: 1 };
    const baseline = lib.commit(original);
    const before = signature(lib.materialize(baseline));

    const branch = lib.fork(baseline);
    const draft = branch.checkout<typeof original>();
    draft.user.name = "grace";
    draft.user.tags.push("y");
    draft.count = 99;
    branch.commit(draft);

    const after = signature(lib.materialize(baseline));
    assert.equal(after, before);
    assert.equal(after, signature(referenceDeepClone(original)));
  });

  it("mutating the source object after commit does not affect the snapshot", () => {
    const lib = new FixtureLibrary();
    const graph = { a: { b: 1 } };
    const snap = lib.commit(graph);
    graph.a.b = 42;
    const view = lib.materialize<{ a: { b: number } }>(snap);
    assert.equal(view.a.b, 1);
  });
});

describe("aliases and cycles", () => {
  it("shared references stay shared through commit + materialize", () => {
    const lib = new FixtureLibrary();
    const shared = { v: 7 };
    const snap = lib.commit({ p: shared, q: shared, list: [shared, shared] });
    const view = lib.materialize<any>(snap);
    assert.ok(view.p === view.q);
    assert.ok(view.p === view.list[0]);
    assert.ok(view.list[0] === view.list[1]);
  });

  it("self and mutual cycles round-trip via stable IDs", () => {
    const lib = new FixtureLibrary();
    const a: any = { name: "a" };
    const b: any = { name: "b", peer: a };
    a.self = a;
    a.peer = b;
    const snap = lib.commit(a);
    const view = lib.materialize<any>(snap);
    assert.ok(view.self === view);
    assert.ok(view.peer.peer === view);
    assert.equal(view.peer.name, "b");
  });

  it("node IDs are stable across commits of the same objects", () => {
    const lib = new FixtureLibrary();
    const child = { x: 1 };
    const snap1 = lib.commit({ child });
    const idOf = (snap: Snapshot, pred: (f: Record<string, unknown>) => boolean) =>
      [...snap.nodes.entries()].find(
        ([, n]) => n.kind === "record" && pred(n.fields as Record<string, unknown>),
      )?.[0];
    const childId1 = idOf(snap1, (f) => typeof f["x"] === "number");
    assert.ok(childId1 !== undefined);

    const view = lib.materialize<any>(snap1);
    view.child.x = 2;
    view.extra = "new";
    const snap2 = lib.commit(view);
    const childId2 = idOf(snap2, (f) => typeof f["x"] === "number");
    assert.equal(childId2, childId1);
  });
});

describe("three-way merge", () => {
  function setup(baseGraph: unknown) {
    const lib = new FixtureLibrary();
    const base = lib.commit(baseGraph);
    const oursView = lib.materialize<any>(base);
    const theirsView = lib.materialize<any>(base);
    return { lib, base, oursView, theirsView };
  }

  it("merges non-conflicting changes from both sides", () => {
    const { lib, base, oursView, theirsView } = setup({ a: 1, b: 2 });
    oursView.a = 10;
    theirsView.b = 20;
    const result = lib.merge(base, lib.commit(oursView), lib.commit(theirsView));
    assert.ok(result.ok);
    const merged = lib.materialize<any>(result.snapshot);
    assert.deepEqual(merged, { a: 10, b: 20 });
  });

  it("reports conflict when both sides set the same field to different values", () => {
    const { lib, base, oursView, theirsView } = setup({ x: 1 });
    oursView.x = 2;
    theirsView.x = 3;
    const result = lib.merge(base, lib.commit(oursView), lib.commit(theirsView));
    assert.ok(!result.ok);
    assert.equal(result.conflicts.length, 1);
    const c = result.conflicts[0]!;
    assert.equal(c.kind, "field-value");
    assert.equal(c.field, "x");
    assert.equal(c.base, 1);
    assert.equal(c.ours, 2);
    assert.equal(c.theirs, 3);
  });

  it("accepts identical changes on both sides", () => {
    const { lib, base, oursView, theirsView } = setup({ x: 1 });
    oursView.x = 5;
    theirsView.x = 5;
    const result = lib.merge(base, lib.commit(oursView), lib.commit(theirsView));
    assert.ok(result.ok);
    assert.equal(lib.materialize<any>(result.snapshot).x, 5);
  });

  it("reports delete-vs-modify conflict", () => {
    const { lib, base, oursView, theirsView } = setup({ keep: 1, drop: { v: 1 } });
    delete oursView.drop;
    theirsView.drop.v = 2;
    const result = lib.merge(base, lib.commit(oursView), lib.commit(theirsView));
    assert.ok(!result.ok);
    assert.equal(result.conflicts[0]!.kind, "delete-modify");
  });

  it("merges through cycles without stack overflow", () => {
    const { lib, base, oursView, theirsView } = setup({ x: 1 });
    oursView.self = oursView;
    oursView.x = 2;
    const result = lib.merge(base, lib.commit(oursView), lib.commit(theirsView));
    assert.ok(result.ok);
    const merged = lib.materialize<any>(result.snapshot);
    assert.ok(merged.self === merged);
    assert.equal(merged.x, 2);
  });

  it("one-sided changes always merge cleanly", () => {
    const { lib, base, oursView, theirsView } = setup({ a: { b: [1, 2] }, c: "s" });
    oursView.a.b.push(3);
    oursView.c = "changed";
    const result = lib.merge(base, lib.commit(oursView), lib.commit(theirsView));
    assert.ok(result.ok);
    const merged = lib.materialize<any>(result.snapshot);
    assert.deepEqual(merged, { a: { b: [1, 2, 3] }, c: "changed" });
  });
});

describe("random graphs vs deep-copy reference model", () => {
  it("round-trip matches reference deep clone (structure + alias topology)", () => {
    const lib = new FixtureLibrary();
    for (let seed = 1; seed <= 300; seed++) {
      const rng = mulberry32(seed);
      const graph = randomGraph(rng, 3 + Math.floor(rng() * 8));
      const expected = signature(referenceDeepClone(graph));
      const snap = lib.commit(graph);
      const actual = signature(lib.materialize(snap));
      assert.equal(actual, expected, `seed ${seed}`);
    }
  });

  it("random branch mutations never pollute the baseline", () => {
    const lib = new FixtureLibrary();
    for (let seed = 1; seed <= 100; seed++) {
      const rng = mulberry32(10_000 + seed);
      const graph = randomGraph(rng, 3 + Math.floor(rng() * 8));
      const baseline = lib.commit(graph);
      const baselineSig = signature(referenceDeepClone(graph));

      const branch = lib.fork(baseline);
      const draft = branch.checkout();
      const objects = collectObjects(draft);
      const mutRng = mulberry32(20_000 + seed);
      const mutations = randomMutations(mutRng, objects.length, 5);
      applyMutations(objects, mutations, mulberry32(30_000 + seed));
      branch.commit(draft);

      assert.equal(signature(lib.materialize(baseline)), baselineSig, `seed ${seed}`);
    }
  });

  it("library checkout mutated by script matches reference clone mutated by same script", () => {
    const lib = new FixtureLibrary();
    for (let seed = 1; seed <= 100; seed++) {
      const rng = mulberry32(40_000 + seed);
      const graph = randomGraph(rng, 3 + Math.floor(rng() * 8));

      const snap = lib.commit(graph);
      const libView = lib.materialize(snap);
      const refView = referenceDeepClone(graph);

      const scriptRng = mulberry32(50_000 + seed);
      const mutations = randomMutations(scriptRng, collectObjects(refView).length, 6);
      applyMutations(collectObjects(libView), mutations, mulberry32(60_000 + seed));
      applyMutations(collectObjects(refView), mutations, mulberry32(60_000 + seed));

      assert.equal(signature(libView), signature(refView), `seed ${seed}`);
      // And the mutated library view still round-trips consistently.
      const snap2 = lib.commit(libView);
      assert.equal(signature(lib.materialize(snap2)), signature(refView), `seed ${seed} recommit`);
    }
  });

  it("one-sided random mutations merge cleanly and match the mutated side", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const lib = new FixtureLibrary();
      const rng = mulberry32(70_000 + seed);
      const graph = randomGraph(rng, 3 + Math.floor(rng() * 8));
      const base = lib.commit(graph);

      const oursView = lib.materialize<any>(base);
      const theirsView = lib.materialize<any>(base);
      const objects = collectObjects(oursView);
      const scriptRng = mulberry32(80_000 + seed);
      const mutations = randomMutations(scriptRng, objects.length, 5);
      applyMutations(objects, mutations, mulberry32(90_000 + seed));

      const ours = lib.commit(oursView);
      const theirs = lib.commit(theirsView);
      const result = lib.merge(base, ours, theirs);
      assert.ok(result.ok, `seed ${seed} conflicts: ${!result.ok && JSON.stringify(result.conflicts)}`);
      assert.equal(signature(lib.materialize(result.snapshot)), signature(oursView), `seed ${seed}`);
    }
  });
});
