import assert from "node:assert/strict";
import test from "node:test";
import {
  DomSnapshotApplier,
  type NodePayload,
  type SnapshotEvent,
} from "../index.ts";

const doc: NodePayload = { id: 1, tag: "#document" };

function freshApplier(options?: ConstructorParameters<typeof DomSnapshotApplier>[0]) {
  const applier = new DomSnapshotApplier(options);
  applier.loadFullSnapshot(doc);
  return applier;
}

test("applies insert/attribute/text/shadowRoot events and matches the full snapshot hash", () => {
  const applier = freshApplier();
  const events: SnapshotEvent[] = [
    { type: "insert", parentId: 1, node: { id: 2, tag: "div" } },
    { type: "attribute", nodeId: 2, name: "class", value: "card" },
    { type: "insert", parentId: 2, node: { id: 3, tag: "span", children: [{ id: 4, tag: "#text", text: "hi" }] } },
    { type: "text", nodeId: 4, text: "hello" },
    { type: "shadowRoot", hostId: 2, root: { id: 5, tag: "#shadow-root", children: [{ id: 6, tag: "em", text: "!" }] } },
    { type: "attribute", nodeId: 2, name: "class", value: null },
  ];
  for (const event of events) assert.equal(applier.apply(event), "applied");

  const fullSnapshot: NodePayload = {
    id: 1,
    tag: "#document",
    children: [
      {
        id: 2,
        tag: "div",
        children: [{ id: 3, tag: "span", children: [{ id: 4, tag: "#text", text: "hello" }] }],
        shadowRoot: { id: 5, tag: "#shadow-root", children: [{ id: 6, tag: "em", text: "!" }] },
      },
    ],
  };
  assert.equal(applier.version, events.length);
  assert.ok(applier.verifyAgainstSnapshot(fullSnapshot));
  assert.equal(applier.currentHash(), applier.hashAtVersion(applier.version));
});

test("defers events for unknown nodes and flushes them once dependencies arrive", () => {
  const applier = freshApplier();
  assert.equal(applier.apply({ type: "attribute", nodeId: 10, name: "id", value: "p1" }), "deferred");
  assert.equal(applier.apply({ type: "text", nodeId: 11, text: "world" }), "deferred");
  assert.equal(applier.stats().pendingCount, 2);

  assert.equal(
    applier.apply({ type: "insert", parentId: 1, node: { id: 10, tag: "p", children: [{ id: 11, tag: "#text" }] } }),
    "applied",
  );
  assert.equal(applier.stats().pendingCount, 0);
  assert.ok(
    applier.verifyAgainstSnapshot({
      id: 1,
      tag: "#document",
      children: [
        { id: 10, tag: "p", attributes: { id: "p1" }, children: [{ id: 11, tag: "#text", text: "world" }] },
      ],
    }),
  );
});

test("removing a parent tree invalidates later events for its nodes", () => {
  const applier = freshApplier();
  applier.apply({ type: "insert", parentId: 1, node: { id: 2, tag: "div", children: [{ id: 3, tag: "b" }] } });
  applier.apply({ type: "remove", nodeId: 2 });

  assert.equal(applier.apply({ type: "attribute", nodeId: 3, name: "x", value: "y" }), "stale");
  assert.equal(applier.apply({ type: "text", nodeId: 2, text: "gone" }), "stale");
  assert.equal(applier.stats().staleEvents, 2);
  assert.ok(applier.verifyAgainstSnapshot(doc));
});

test("a remove flushed from the queue purges queued events for the deleted subtree", () => {
  const applier = freshApplier();
  // Both events reference missing nodes, so they wait in order.
  assert.equal(applier.apply({ type: "remove", nodeId: 3 }), "deferred");
  assert.equal(applier.apply({ type: "attribute", nodeId: 4, name: "a", value: "b" }), "deferred");

  // Inserting the subtree flushes the remove first; the queued attribute
  // event targets a node inside the just-deleted tree and is invalidated.
  applier.apply({ type: "insert", parentId: 1, node: { id: 3, tag: "div", children: [{ id: 4, tag: "i" }] } });

  assert.equal(applier.stats().pendingCount, 0);
  assert.equal(applier.stats().staleEvents, 1);
  assert.ok(applier.verifyAgainstSnapshot(doc));
});

test("waiting area is bounded and drops the oldest events", () => {
  const applier = freshApplier({ maxPendingEvents: 2 });
  assert.equal(applier.apply({ type: "text", nodeId: 20, text: "first" }), "deferred");
  assert.equal(applier.apply({ type: "text", nodeId: 21, text: "second" }), "deferred");
  assert.equal(applier.apply({ type: "text", nodeId: 22, text: "third" }), "deferred");

  assert.equal(applier.stats().pendingCount, 2);
  assert.equal(applier.stats().droppedPending, 1);

  applier.apply({
    type: "insert",
    parentId: 1,
    node: { id: 20, tag: "#text", text: "" },
  });
  // The dropped event for node 20 never applies; 21/22 still wait.
  assert.equal(applier.stats().pendingCount, 2);
  assert.ok(
    applier.verifyAgainstSnapshot({ id: 1, tag: "#document", children: [{ id: 20, tag: "#text", text: "" }] }),
  );
});

test("hashes are deterministic and verifiable per version", () => {
  const events: SnapshotEvent[] = [
    { type: "insert", parentId: 1, node: { id: 2, tag: "ul" } },
    { type: "insert", parentId: 2, node: { id: 3, tag: "li", text: "a" } },
    { type: "insert", parentId: 2, index: 0, node: { id: 4, tag: "li", text: "b" } },
    { type: "attribute", nodeId: 2, name: "data-n", value: "2" },
  ];
  const run = () => {
    const applier = freshApplier();
    for (const event of events) applier.apply(event);
    return applier;
  };
  const a = run();
  const b = run();
  assert.equal(a.currentHash(), b.currentHash());
  assert.match(a.currentHash(), /^[0-9a-f]{16}$/);

  // Version 3 (before the attribute event) verifies against its own snapshot.
  assert.ok(
    a.verifyAgainstSnapshot(
      {
        id: 1,
        tag: "#document",
        children: [
          {
            id: 2,
            tag: "ul",
            children: [
              { id: 4, tag: "li", text: "b" },
              { id: 3, tag: "li", text: "a" },
            ],
          },
        ],
      },
      3,
    ),
  );
  // A mismatched snapshot does not verify.
  assert.equal(a.verifyAgainstSnapshot(doc), false);
});

test("duplicate payload ids are rejected as stale", () => {
  const applier = freshApplier();
  applier.apply({ type: "insert", parentId: 1, node: { id: 2, tag: "div" } });
  assert.equal(applier.apply({ type: "insert", parentId: 1, node: { id: 2, tag: "span" } }), "stale");
  assert.equal(applier.stats().nodeCount, 2);
});

test("removing the root clears the tree and hashes the empty state", () => {
  const applier = freshApplier();
  applier.apply({ type: "insert", parentId: 1, node: { id: 2, tag: "div" } });
  applier.apply({ type: "remove", nodeId: 1 });
  assert.equal(applier.root, null);
  assert.equal(applier.stats().nodeCount, 0);
  assert.equal(applier.currentHash(), "cbf29ce484222325");
});
