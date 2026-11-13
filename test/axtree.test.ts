import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AXTreeStore, type AXNodeInput } from "../index.js";

const baseTree: AXNodeInput[] = [
  { backendNodeId: 1, role: "RootWebArea", name: "doc", childIds: [2, 3] },
  { backendNodeId: 2, role: "button", name: "Save" },
  { backendNodeId: 3, role: "generic", name: "", ignored: true, childIds: [4] },
  { backendNodeId: 4, role: "textbox", name: "Email" },
];

describe("AXTreeStore", () => {
  it("loads a document and binds queries to versions", () => {
    const store = new AXTreeStore();
    const v1 = store.loadDocument("doc-1", baseTree);
    assert.equal(v1.version, 1);
    assert.equal(v1.rootId, 1);
    assert.equal(v1.getNode(2)?.role, "button");

    store.applyUpdates([{ backendNodeId: 2, name: "Save as" }]);
    assert.equal(store.latestVersion, 2);

    const again = store.getSnapshot(1);
    assert.equal(again.getNode(2)?.name, "Save");
    assert.equal(store.getSnapshot(2).getNode(2)?.name, "Save as");
    assert.throws(() => store.getSnapshot(99), /unknown version/);
  });

  it("collapses ignored nodes and re-mounts their subtree", () => {
    const store = new AXTreeStore();
    const v1 = store.loadDocument("doc-1", baseTree);

    assert.deepEqual(
      v1.effectiveChildren(1).map((n) => n.backendNodeId),
      [2, 4],
    );
    assert.equal(v1.effectiveParentId(4), 1);

    const { snapshot: v2, diff } = store.applyUpdates([
      { backendNodeId: 3, ignored: false },
    ]);
    assert.deepEqual(
      v2.effectiveChildren(1).map((n) => n.backendNodeId),
      [2, 3],
    );
    assert.equal(v2.effectiveParentId(4), 3);
    assert.deepEqual(
      diff.reparented.map((r) => [
        r.id,
        r.fromEffectiveParentId,
        r.toEffectiveParentId,
      ]),
      [[4, 1, 3]],
    );
    assert.deepEqual(
      diff.changed.map((c) => c.id),
      [3],
    );
  });

  it("matches full rebuild after incremental updates", () => {
    const updates: AXNodeInput[] = [
      { backendNodeId: 2, name: "Save as", properties: { focused: true } },
      { backendNodeId: 3, ignored: false },
      { backendNodeId: 5, role: "link", name: "Help" },
      { backendNodeId: 1, childIds: [2, 3, 5] },
    ];

    const incremental = new AXTreeStore();
    incremental.loadDocument("doc-1", baseTree);
    const { snapshot: applied } = incremental.applyUpdates(updates);

    const merged = new Map<number, AXNodeInput>();
    for (const node of baseTree) merged.set(node.backendNodeId, { ...node });
    for (const update of updates) {
      merged.set(update.backendNodeId, {
        ...merged.get(update.backendNodeId),
        ...update,
      });
    }
    const rebuilt = new AXTreeStore();
    const full = rebuilt.loadDocument("doc-1", [...merged.values()]);

    const stripMeta = (json: unknown): unknown => {
      const { version: _v, documentEpoch: _e, ...rest } = json as Record<
        string,
        unknown
      >;
      return rest;
    };
    assert.deepEqual(stripMeta(applied.toJSON()), stripMeta(full.toJSON()));
    assert.equal(applied.size, full.size);
  });

  it("prunes detached subtrees and reports removals", () => {
    const store = new AXTreeStore();
    store.loadDocument("doc-1", baseTree);
    const { snapshot, diff } = store.applyUpdates([
      { backendNodeId: 1, childIds: [2] },
    ]);
    assert.equal(snapshot.has(3), false);
    assert.equal(snapshot.has(4), false);
    assert.deepEqual(diff.removed, [3, 4]);
    assert.equal(snapshot.size, 2);
  });

  it("rejects id reuse across document switches", () => {
    const store = new AXTreeStore();
    store.loadDocument("doc-1", baseTree);
    assert.throws(
      () =>
        store.loadDocument("doc-2", [
          { backendNodeId: 2, role: "RootWebArea", name: "other" },
        ]),
      /cannot be reused/,
    );
    const ok = store.loadDocument("doc-2", [
      {
        backendNodeId: 100,
        role: "RootWebArea",
        name: "other",
        childIds: [101],
      },
      { backendNodeId: 101, role: "button", name: "OK" },
    ]);
    assert.equal(ok.documentEpoch, 2);
    assert.equal(ok.rootId, 100);
    assert.throws(
      () => store.applyUpdates([{ backendNodeId: 2, role: "button" }]),
      /cannot be reused/,
    );
  });

  it("diffs arbitrary version pairs", () => {
    const store = new AXTreeStore();
    store.loadDocument("doc-1", baseTree);
    store.applyUpdates([{ backendNodeId: 2, name: "Save as" }]);
    store.applyUpdates([
      { backendNodeId: 6, role: "dialog", name: "Confirm" },
      { backendNodeId: 1, childIds: [2, 3, 6] },
    ]);
    const diff = store.diff(1, 3);
    assert.deepEqual(diff.added, [6]);
    assert.deepEqual(
      diff.changed.map((c) => c.id),
      [1, 2],
    );
    assert.equal(diff.fromVersion, 1);
    assert.equal(diff.toVersion, 3);
  });

  it("validates structural invariants on load", () => {
    const store = new AXTreeStore();
    assert.throws(
      () => store.loadDocument("doc", [{ backendNodeId: 1, childIds: [2] }]),
      /unknown child/,
    );
    assert.throws(
      () =>
        store.loadDocument("doc", [
          { backendNodeId: 1, childIds: [2] },
          { backendNodeId: 2, childIds: [1] },
        ]),
      /exactly one root/,
    );
    assert.throws(
      () =>
        store.loadDocument("doc", [{ backendNodeId: 1 }, { backendNodeId: 1 }]),
      /duplicate backendNodeId/,
    );
  });
});
