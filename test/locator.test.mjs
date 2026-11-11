import test from "node:test";
import assert from "node:assert/strict";

import {
  MockBrowserAdapter,
  SnapshotValidationError,
  buildComposedTree,
  isSnapshotValidationError,
  locateByRoleAndName,
} from "../dist/index.js";

function snapshotError(code) {
  return (error) => {
    assert.ok(error instanceof SnapshotValidationError, String(error));
    assert.equal(error.code, code);
    return true;
  };
}

function ids(result) {
  return result.candidates.map((candidate) => candidate.id);
}

test("composes nested open shadow roots, explicit slots, fallbacks, and closed roots", () => {
  const innerButton = { id: "inner-button", role: "button", name: "Deep" };
  const stray = { id: "stray", role: "button", name: "Stray" };
  const fallbackButton = {
    id: "fallback-button",
    role: "button",
    name: "Fallback",
  };
  const shadowedFallback = {
    id: "shadowed-fallback",
    role: "button",
    name: "Shadowed fallback",
  };
  const secretButton = {
    id: "secret-button",
    role: "button",
    name: "Secret",
  };
  const innerHost = {
    id: "inner-host",
    role: "group",
    name: "Card",
    children: [innerButton],
    shadowRoot: {
      mode: "open",
      children: [
        {
          id: "inner-slot",
          kind: "slot",
          role: "presentation",
          slot: { name: "body", assignedNodes: [innerButton] },
        },
      ],
    },
  };

  const tree = {
    id: "doc",
    role: "document",
    children: [
      {
        id: "outer-host",
        role: "group",
        name: "Shell",
        // inner-host is a light child but is only visible through outer-slot.
        children: [stray, innerHost],
        shadowRoot: {
          mode: "open",
          children: [
            {
              id: "outer-slot",
              kind: "slot",
              role: "presentation",
              slot: { name: "content", assignedNodes: [innerHost] },
              // Assigned nodes win; fallback children must stay hidden.
              children: [shadowedFallback],
            },
            {
              id: "fallback-slot",
              kind: "slot",
              role: "presentation",
              slot: { name: "footer", assignedNodes: [] },
              children: [fallbackButton],
            },
          ],
        },
      },
      {
        id: "closed-host",
        role: "group",
        name: "Closed",
        shadowRoot: {
          mode: "closed",
          children: [secretButton],
        },
      },
    ],
  };

  const version = buildComposedTree(tree);
  assert.equal(version.nodes.length, 6);
  assert.deepEqual(
    version.nodes.map((node) => node.id),
    [
      "doc",
      "outer-host",
      "inner-host",
      "inner-button",
      "fallback-button",
      "closed-host",
    ],
  );

  // Slot placeholders are transparent and never queryable.
  assert.equal(version.get("outer-slot"), undefined);
  assert.equal(version.get("inner-slot"), undefined);

  const deep = locateByRoleAndName(version, "button", "Deep");
  assert.equal(deep.status, "found");
  assert.equal(deep.node.id, "inner-button");
  assert.deepEqual(deep.node.path.nodeIds, [
    "doc",
    "outer-host",
    "inner-host",
    "inner-button",
  ]);
  assert.equal(deep.node.path.steps[1].kind, "light");
  assert.equal(deep.node.path.steps[2].kind, "slot-assigned");
  assert.equal(deep.node.path.steps[2].slotId, "outer-slot");
  assert.equal(deep.node.path.steps[3].kind, "slot-assigned");
  assert.equal(deep.node.path.steps[3].slotId, "inner-slot");
  assert.equal(deep.node.depth, 3);

  const fallback = locateByRoleAndName(version, "button", "Fallback");
  assert.equal(fallback.status, "found");
  assert.equal(fallback.node.id, "fallback-button");
  assert.equal(fallback.node.via, "slot-fallback");

  // Light children replaced by open roots, and closed roots, stay invisible.
  assert.equal(locateByRoleAndName(version, "button", "Stray").status, "not-found");
  assert.equal(locateByRoleAndName(version, "button", "Secret").status, "not-found");
  assert.equal(
    locateByRoleAndName(version, "button", "Shadowed fallback").status,
    "not-found",
  );

  // Every actually rendered node occurs exactly once.
  assert.equal(
    version.nodes.filter((node) => node.id === "inner-button").length,
    1,
  );
});

test("duplicate assignments and duplicate structural nodes reject the whole version", () => {
  const duplicateAssignment = {
    roots: ["host"],
    nodes: {
      host: {
        role: "group",
        children: ["assigned"],
        shadowRoot: { mode: "open", children: ["slot-1", "slot-2"] },
      },
      "slot-1": {
        kind: "slot",
        role: "presentation",
        slot: { assignedNodes: ["assigned"] },
      },
      "slot-2": {
        kind: "slot",
        role: "presentation",
        slot: { assignedNodes: ["assigned"] },
      },
      assigned: { role: "button", name: "Once" },
    },
  };

  assert.throws(
    () => buildComposedTree(duplicateAssignment),
    snapshotError("DUPLICATE_ASSIGNMENT"),
  );

  const duplicateNode = {
    roots: ["root"],
    nodes: {
      root: { role: "document", children: ["parent-a", "parent-b"] },
      "parent-a": { role: "group", children: ["shared"] },
      "parent-b": { role: "group", children: ["shared"] },
      shared: { role: "button", name: "Shared" },
    },
  };

  assert.throws(
    () => buildComposedTree(duplicateNode),
    snapshotError("DUPLICATE_NODE"),
  );
});

test("cycles through slot assignment reject the whole version", () => {
  const cyclic = {
    roots: ["host"],
    nodes: {
      host: {
        role: "group",
        children: ["light"],
        shadowRoot: { mode: "open", children: ["slot"] },
      },
      light: { role: "button", name: "Light" },
      slot: {
        kind: "slot",
        role: "presentation",
        slot: { assignedNodes: ["host"] },
      },
    },
  };

  assert.throws(
    () => buildComposedTree(cyclic),
    snapshotError("CYCLE"),
  );

  // Even a malformed orphan cycle is rejected instead of partially exposed.
  const orphanCycle = {
    roots: ["root"],
    nodes: {
      root: { role: "document" },
      a: { role: "group", children: ["b"] },
      b: { role: "group", children: ["a"] },
    },
  };
  assert.throws(
    () => buildComposedTree(orphanCycle),
    snapshotError("CYCLE"),
  );
});

test("ambiguous names return every candidate and never silently choose one", () => {
  const version = buildComposedTree({
    id: "doc",
    role: "document",
    children: [
      { id: "delete-a", role: "button", name: "Delete" },
      { id: "delete-b", role: "button", name: "Delete" },
      { id: "save", role: "button", name: "Save" },
      {
        id: "closed",
        role: "group",
        shadowRoot: {
          mode: "closed",
          children: [
            { id: "delete-hidden", role: "button", name: "Delete" },
          ],
        },
      },
    ],
  });

  const result = locateByRoleAndName(version, "button", "Delete");
  assert.equal(result.status, "ambiguous");
  assert.equal(result.matchCount, 2);
  assert.deepEqual(ids(result), ["delete-a", "delete-b"]);
  assert.ok(result.candidates[0].path.nodeIds.includes("delete-a"));

  const unique = locateByRoleAndName(version, "button", "Save");
  assert.equal(unique.status, "found");
  assert.equal(unique.node.id, "save");

  const missing = locateByRoleAndName(version, "button", "Missing");
  assert.equal(missing.status, "not-found");
  assert.deepEqual(missing.candidates, []);
});

test("host re-parenting keeps slot-assigned content composed and old paths resolvable", () => {
  const target = { id: "target", role: "button", name: "Reparent me" };
  const adapter = new MockBrowserAdapter({
    id: "doc",
    role: "document",
    children: [
      {
        id: "section-a",
        role: "region",
        name: "A",
        children: [
          {
            id: "host",
            role: "group",
            name: "Host",
            children: [target],
            shadowRoot: {
              mode: "open",
              children: [
                {
                  id: "host-slot",
                  kind: "slot",
                  role: "presentation",
                  slot: { name: "target", assignedNodes: [target] },
                },
              ],
            },
          },
        ],
      },
      { id: "section-b", role: "region", name: "B" },
    ],
  });

  const before = adapter.locate("button", "Reparent me");
  assert.equal(before.status, "found");
  assert.deepEqual(before.node.path.nodeIds, [
    "doc",
    "section-a",
    "host",
    "target",
  ]);
  const oldPath = before.node.path;

  const updated = adapter.batch((transaction) => {
    transaction.reparent("host", "section-b");
  });

  assert.equal(updated.revision, 1);
  const after = adapter.locate("button", "Reparent me");
  assert.equal(after.status, "found");
  assert.equal(after.node.id, "target");
  assert.deepEqual(after.node.path.nodeIds, [
    "doc",
    "section-b",
    "host",
    "target",
  ]);
  assert.equal(adapter.resolvePath(oldPath)?.id, "target");
  assert.equal(
    adapter.snapshot().nodes.filter((node) => node.id === "target").length,
    1,
  );
});

test("one batch update does not invalidate recorded paths or hide new ambiguity", () => {
  const adapter = new MockBrowserAdapter({
    id: "doc",
    role: "document",
    children: [{ id: "save", role: "button", name: "Save" }],
  });

  const before = adapter.locate("button", "Save");
  assert.equal(before.status, "found");
  const recordedPath = before.node.path;
  const recordedPathJson = JSON.stringify(recordedPath);

  adapter.applyBatch([
    {
      type: "insertBefore",
      parentId: "doc",
      beforeId: "save",
      child: { id: "spacer", role: "generic", name: "Spacer" },
    },
    {
      type: "appendChild",
      parentId: "doc",
      child: { id: "save-copy", role: "button", name: "Save" },
    },
  ]);

  assert.equal(adapter.revision, 1);
  assert.equal(adapter.resolvePath(recordedPath)?.id, "save");
  assert.equal(adapter.resolvePath(["doc", "save"])?.id, "save");

  const current = adapter.getNode("save");
  assert.ok(current);
  assert.deepEqual(current.path.nodeIds, ["doc", "save"]);
  assert.equal(JSON.stringify(current.path), recordedPathJson);

  const ambiguous = adapter.locate("button", "Save");
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ids(ambiguous), ["save", "save-copy"]);
});

test("an invalid batch is rejected atomically and the previous version stays usable", () => {
  const sharedA = { id: "a", role: "button", name: "A" };
  const sharedB = { id: "b", role: "button", name: "B" };
  const adapter = new MockBrowserAdapter({
    id: "doc",
    role: "document",
    children: [
      {
        id: "host",
        role: "group",
        children: [sharedA, sharedB],
        shadowRoot: {
          mode: "open",
          children: [
            {
              id: "slot-a",
              kind: "slot",
              role: "presentation",
              slot: { assignedNodes: [sharedA] },
            },
            {
              id: "slot-b",
              kind: "slot",
              role: "presentation",
              slot: { assignedNodes: [sharedB] },
            },
          ],
        },
      },
    ],
  });

  const beforeRevision = adapter.revision;
  const beforeA = adapter.locate("button", "A");
  assert.equal(beforeA.status, "found");

  assert.throws(
    () =>
      adapter.batch((transaction) => {
        transaction.setSlotAssignments("slot-b", ["a"]);
      }),
    (error) => {
      assert.ok(isSnapshotValidationError(error));
      assert.equal(error.code, "DUPLICATE_ASSIGNMENT");
      return true;
    },
  );

  assert.equal(adapter.revision, beforeRevision);
  assert.equal(adapter.locate("button", "A").node.id, "a");
  assert.equal(adapter.locate("button", "B").node.id, "b");
});
