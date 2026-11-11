import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MissingDependencyError,
  Patch,
  PatchConflictError,
  PatchProtocolError,
  ResultAssembler,
} from "../src/index.js";

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (isObj(target[key]) && isObj(value)) {
      mergeInto(target[key] as Record<string, unknown>, value);
    } else {
      target[key] = value;
    }
  }
}

function applySequential(initial: unknown, patches: readonly Patch[]): unknown {
  const tree = structuredClone(initial) as Record<string, unknown>;
  for (const patch of patches) {
    let target: unknown = tree;
    for (const segment of patch.path) {
      target = (target as Record<string, unknown>)[segment as string];
    }
    if (patch.op.kind === "merge") {
      mergeInto(target as Record<string, unknown>, patch.op.value);
    } else {
      (target as unknown[]).splice(patch.op.index, 0, ...patch.op.items);
    }
  }
  return tree;
}

function assertDeepFrozen(value: unknown): void {
  if (!isObj(value) && !Array.isArray(value)) return;
  assert.ok(Object.isFrozen(value), "expected node to be frozen");
  for (const item of Object.values(value)) {
    assertDeepFrozen(item);
  }
}

test("deep nesting: merges and inserts match sequential execution", () => {
  const initial = {
    data: { l1: { l2: { l3: { l4: { list: ["a", "b"], attrs: { x: 1 } } } } } },
  };
  const deepList = ["data", "l1", "l2", "l3", "l4", "list"];
  const deepAttrs = ["data", "l1", "l2", "l3", "l4", "attrs"];
  const patches: Patch[] = [
    { id: "p1", parentId: null, path: deepAttrs, op: { kind: "merge", value: { y: 2, nested: { z: 3 } } } },
    { id: "p2", parentId: null, path: deepList, op: { kind: "insert", index: 1, items: ["x", "y"] } },
    { id: "p3", parentId: null, path: ["data", "l1", "l2"], op: { kind: "merge", value: { note: "hi" } } },
    { id: "p4", parentId: null, path: deepAttrs, op: { kind: "merge", value: { nested: { w: 4 } } } },
    { id: "p5", parentId: null, path: deepList, op: { kind: "insert", index: 0, items: ["head"] } },
  ];
  const assembler = new ResultAssembler(initial);
  for (const patch of patches) {
    assembler.addPatch(patch);
  }
  assert.deepEqual(assembler.current, applySequential(initial, patches));
  assert.equal(assembler.versions.length, patches.length + 1);
  assert.equal(assembler.pendingIds().length, 0);
  assert.equal(assembler.finalize(), assembler.current);
});

test("late parent: children stay pending, then cascade in seq order", () => {
  const initial = { feed: ["a", "b"] };
  const applied: Array<string | null> = [];
  const assembler = new ResultAssembler(initial, {
    onVersion: (_version, patchId) => applied.push(patchId),
  });
  const c1: Patch = { id: "c1", parentId: "p1", path: ["feed"], op: { kind: "insert", index: 0, items: ["c1"] } };
  const c2: Patch = { id: "c2", parentId: "p1", path: ["feed"], op: { kind: "insert", index: 0, items: ["c2"] } };
  assembler.addPatch(c2);
  assembler.addPatch(c1);
  assert.deepEqual(assembler.pendingIds(), ["c2", "c1"]);
  assert.equal(assembler.versions.length, 1);
  assert.deepEqual(assembler.current, initial);

  const p1: Patch = {
    id: "p1",
    parentId: null,
    path: [],
    op: { kind: "merge", value: { tag: "p1" } },
    children: [
      { id: "c2", seq: 2 },
      { id: "c1", seq: 1 },
    ],
  };
  assembler.addPatch(p1);
  assert.deepEqual(applied, ["p1", "c1", "c2"]);
  assert.deepEqual(assembler.pendingIds(), []);
  const expected = applySequential(initial, [p1, c1, c2]);
  assert.deepEqual(assembler.current, expected);
  assert.deepEqual((assembler.current as { feed: unknown[] }).feed, ["c2", "c1", "a", "b"]);
});

test("list positions are interpreted against the completed parent version", () => {
  const initial = { feed: ["a", "b"] };
  const parent: Patch = {
    id: "parent",
    parentId: null,
    path: ["feed"],
    op: { kind: "insert", index: 0, items: ["p1", "p2"] },
    children: [{ id: "child", seq: 1 }],
  };
  const child: Patch = {
    id: "child",
    parentId: "parent",
    path: ["feed"],
    op: { kind: "insert", index: 1, items: ["c"] },
  };
  const assembler = new ResultAssembler(initial);
  assembler.addPatch(child);
  assert.deepEqual(assembler.current, initial);
  assembler.addPatch(parent);
  const expected = applySequential(initial, [parent, child]);
  assert.deepEqual(assembler.current, expected);
  assert.deepEqual((assembler.current as { feed: unknown[] }).feed, ["p1", "c", "p2", "a", "b"]);
});

test("deep nesting with late parent: child targets a path created by its parent", () => {
  const initial = { data: { l1: { l2: {} } } };
  const parent: Patch = {
    id: "parent",
    parentId: null,
    path: ["data", "l1", "l2"],
    op: { kind: "merge", value: { l3: { l4: { items: ["seed"] } } } },
    children: [{ id: "deep-child", seq: 1 }],
  };
  const child: Patch = {
    id: "deep-child",
    parentId: "parent",
    path: ["data", "l1", "l2", "l3", "l4", "items"],
    op: { kind: "insert", index: 1, items: ["grown"] },
  };
  const assembler = new ResultAssembler(initial);
  assembler.addPatch(child);
  assert.equal(assembler.versions.length, 1);
  assembler.addPatch(parent);
  assert.deepEqual(assembler.current, applySequential(initial, [parent, child]));
  assert.equal(assembler.finalize(), assembler.current);
});

test("consumer retains old versions: snapshots stay immutable and unchanged", () => {
  const initial = { feed: ["a"], meta: { page: 1 } };
  const assembler = new ResultAssembler(initial);
  const v0 = assembler.current as { feed: string[]; meta: { page: number } };
  const v0Snapshot = structuredClone(v0);

  assembler.addPatch({ id: "p1", parentId: null, path: ["meta"], op: { kind: "merge", value: { page: 2 } } });
  const v1 = assembler.current as { feed: string[]; meta: { page: number } };
  const v1Snapshot = structuredClone(v1);

  assembler.addPatch({ id: "p2", parentId: null, path: ["feed"], op: { kind: "insert", index: 0, items: ["new"] } });
  assembler.addPatch({ id: "p3", parentId: null, path: ["meta"], op: { kind: "merge", value: { page: 3 } } });

  assert.deepEqual(v0, v0Snapshot);
  assert.deepEqual(v1, v1Snapshot);
  assert.deepEqual(v0.feed, ["a"]);
  assert.equal(v1.meta.page, 2);
  assertDeepFrozen(v0);
  assertDeepFrozen(v1);
  assertDeepFrozen(assembler.current);
  assert.throws(() => {
    v1.feed.push("mutated");
  }, TypeError);
  assert.throws(() => {
    v1.meta.page = 99;
  }, TypeError);
  assert.deepEqual(v1, v1Snapshot);
});

test("conflict: same id with different content raises, identical redelivery is a no-op", () => {
  const assembler = new ResultAssembler({ a: 1 });
  const patch: Patch = { id: "p1", parentId: null, path: [], op: { kind: "merge", value: { b: 2 } } };
  assembler.addPatch(patch);
  assert.throws(
    () =>
      assembler.addPatch({ id: "p1", parentId: null, path: [], op: { kind: "merge", value: { b: 3 } } }),
    PatchConflictError,
  );
  const versionCount = assembler.versions.length;
  assembler.addPatch(structuredClone(patch));
  assert.equal(assembler.versions.length, versionCount);
});

test("finalize: missing dependencies are reported", () => {
  const assembler = new ResultAssembler({ feed: [] });
  assembler.addPatch({
    id: "parent",
    parentId: null,
    path: ["feed"],
    op: { kind: "insert", index: 0, items: ["x"] },
    children: [
      { id: "got", seq: 1 },
      { id: "never-arrives", seq: 2 },
    ],
  });
  assembler.addPatch({ id: "got", parentId: "parent", path: ["feed"], op: { kind: "insert", index: 1, items: ["y"] } });
  assembler.addPatch({ id: "orphan", parentId: "ghost", path: ["feed"], op: { kind: "insert", index: 0, items: [] } });
  let thrown: unknown;
  try {
    assembler.finalize();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof MissingDependencyError);
  const error = thrown as MissingDependencyError;
  const missingIds = error.missing.map((entry) => entry.id).sort();
  assert.deepEqual(missingIds, ["got", "never-arrives", "orphan"]);
  assert.match(error.message, /never-arrives/);
  assert.match(error.message, /ghost/);
  assert.throws(
    () => assembler.addPatch({ id: "late", parentId: null, path: [], op: { kind: "merge", value: {} } }),
    PatchProtocolError,
  );
});

test("protocol: undeclared children and invalid operations are rejected", () => {
  const assembler = new ResultAssembler({ feed: ["a"], n: 1 });
  assembler.addPatch({
    id: "parent",
    parentId: null,
    path: [],
    op: { kind: "merge", value: {} },
    children: [{ id: "declared", seq: 1 }],
  });
  assert.throws(
    () =>
      assembler.addPatch({
        id: "sneaky",
        parentId: "parent",
        path: ["feed"],
        op: { kind: "insert", index: 0, items: ["x"] },
      }),
    PatchProtocolError,
  );
  assert.throws(
    () =>
      assembler.addPatch({ id: "bad-index", parentId: null, path: ["feed"], op: { kind: "insert", index: 5, items: [] } }),
    PatchProtocolError,
  );
  assert.throws(
    () => assembler.addPatch({ id: "bad-merge", parentId: null, path: ["n"], op: { kind: "merge", value: {} } }),
    PatchProtocolError,
  );
  assert.throws(
    () => assembler.addPatch({ id: "bad-path", parentId: null, path: ["missing"], op: { kind: "merge", value: {} } }),
    PatchProtocolError,
  );
});

test("caller-side mutation of patch payloads after submission has no effect", () => {
  const assembler = new ResultAssembler({ feed: [] });
  const items = ["x"];
  const value: Record<string, unknown> = { tag: "t" };
  assembler.addPatch({ id: "p1", parentId: null, path: ["feed"], op: { kind: "insert", index: 0, items } });
  assembler.addPatch({ id: "p2", parentId: null, path: [], op: { kind: "merge", value } });
  items.push("evil");
  value.tag = "evil";
  const current = assembler.current as { feed: string[]; tag: string };
  assert.deepEqual(current.feed, ["x"]);
  assert.equal(current.tag, "t");
});
