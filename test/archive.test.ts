import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  Archive,
  type ArchiveEvent,
  type DeleteEvent,
  type DocumentState,
  type RestoreEvent,
  type UpdateEvent,
} from "../src/index.js";

const DOC = "doc-1";

function update(id: string, content: string, lamport: number, deps: string[] = []): UpdateEvent {
  return { kind: "update", id, doc: DOC, content, lamport, deps };
}

function del(id: string, lamport: number, deps: string[] = []): DeleteEvent {
  return { kind: "delete", id, doc: DOC, lamport, deps };
}

function restore(id: string, deleteRef: string, lamport: number, deps: string[] = []): RestoreEvent {
  return { kind: "restore", id, doc: DOC, deleteRef, lamport, deps };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) result.push([items[i]!, ...tail]);
  }
  return result;
}

function stateOf(events: ArchiveEvent[]): DocumentState {
  return new Archive("viewer").merge(events).documentState(DOC);
}

test("update then read returns content with provenance", () => {
  const a = new Archive("A");
  const u = a.update(DOC, "hello");
  const state = a.documentState(DOC);
  assert.equal(state.status, "active");
  assert.deepEqual(state.branches, [
    { rootRestoreId: null, content: "hello", contentFrom: u.id },
  ]);
  assert.deepEqual(state.tombstones, []);
});

test("delete creates an active tombstone; document is deleted", () => {
  const a = new Archive("A");
  a.update(DOC, "hello");
  const d = a.delete(DOC);
  const state = a.documentState(DOC);
  assert.equal(state.status, "deleted");
  assert.deepEqual(state.tombstones, [
    { deleteId: d.id, active: true, cancelledBy: [] },
  ]);
});

test("restore must reference a known delete version", () => {
  const a = new Archive("A");
  a.update(DOC, "hello");
  assert.throws(() => a.restore(DOC, "A#999"), /known delete version/);
  const u = a.update(DOC, "again");
  assert.throws(() => a.restore(DOC, u.id), /known delete version/);
});

test("restore cancels exactly the referenced tombstone and revives pre-delete content", () => {
  const a = new Archive("A");
  const u1 = a.update(DOC, "v1");
  const u2 = a.update(DOC, "v2");
  const d = a.delete(DOC);
  const r = a.restore(DOC, d.id);
  const state = a.documentState(DOC);
  assert.equal(state.status, "active");
  assert.deepEqual(state.tombstones, [
    { deleteId: d.id, active: false, cancelledBy: [r.id] },
  ]);
  assert.deepEqual(state.branches, [
    { rootRestoreId: r.id, content: "v2", contentFrom: u2.id },
  ]);
  assert.notEqual(state.branches[0]!.contentFrom, u1.id);
});

test("concurrent deletes each need their own restore", () => {
  const a = new Archive("A");
  a.update(DOC, "v1");
  const snap = a.allEvents();

  const b = new Archive("B").merge(snap);
  const c = new Archive("C").merge(snap);
  const d1 = b.delete(DOC);
  const d2 = c.delete(DOC);

  b.merge([d2]);
  const r1 = b.restore(DOC, d1.id);
  b.merge([r1]);
  let state = b.documentState(DOC);
  assert.equal(state.status, "deleted", "d2 tombstone still active");
  assert.deepEqual(
    state.tombstones.map((t) => [t.deleteId, t.active]),
    [
      [d1.id, false],
      [d2.id, true],
    ],
  );

  const r2 = c.restore(DOC, d2.id);
  b.merge([r2]);
  state = b.documentState(DOC);
  assert.equal(state.status, "active");
});

test("update concurrent with a delete does not restore the document", () => {
  const a = new Archive("A");
  a.update(DOC, "v1");
  const snap = a.allEvents();

  const b = new Archive("B").merge(snap);
  const c = new Archive("C").merge(snap);
  const d = b.delete(DOC);
  const stale = c.update(DOC, "stale write"); // has not observed d

  b.merge([stale]);
  assert.equal(b.documentState(DOC).status, "deleted");

  const r = b.restore(DOC, d.id);
  b.merge([r]);
  const state = b.documentState(DOC);
  assert.equal(state.status, "active");
  assert.deepEqual(state.branches, [
    { rootRestoreId: r.id, content: "v1", contentFrom: snap[0]!.id },
  ]);
});

test("concurrent restores keep one branch each", () => {
  const a = new Archive("A");
  a.update(DOC, "base");
  const d = a.delete(DOC);
  const snap = a.allEvents();

  const b = new Archive("B").merge(snap);
  const c = new Archive("C").merge(snap);
  const r1 = b.restore(DOC, d.id);
  const u1 = b.update(DOC, "branch-from-B");
  const r2 = c.restore(DOC, d.id);
  const u2 = c.update(DOC, "branch-from-C");

  const merged = new Archive("M").merge([...b.allEvents(), ...c.allEvents()]);
  const state = merged.documentState(DOC);
  assert.equal(state.status, "active");
  assert.deepEqual(state.branches, [
    { rootRestoreId: r1.id, content: "branch-from-B", contentFrom: u1.id },
    { rootRestoreId: r2.id, content: "branch-from-C", contentFrom: u2.id },
  ]);
});

test("causally ordered restores collapse to the latest branch", () => {
  const a = new Archive("A");
  a.update(DOC, "base");
  const d = a.delete(DOC);
  const r1 = a.restore(DOC, d.id);
  a.update(DOC, "after-r1");
  const d2 = a.delete(DOC);
  const r2 = a.restore(DOC, d2.id);
  const state = a.documentState(DOC);
  assert.equal(state.status, "active");
  assert.equal(state.branches.length, 1);
  assert.equal(state.branches[0]!.rootRestoreId, r2.id);
  assert.equal(state.branches[0]!.content, "after-r1");
  assert.notEqual(r1.id, r2.id);
});

test("dangling restore in a merge is inert", () => {
  const a = new Archive("A");
  a.update(DOC, "v1");
  const d = a.delete(DOC);
  const ghost: RestoreEvent = {
    kind: "restore",
    id: "X#1",
    doc: DOC,
    deleteRef: "X#missing",
    lamport: 9,
    deps: [],
  };
  a.merge([ghost]);
  const state = a.documentState(DOC);
  assert.equal(state.status, "deleted");
  assert.deepEqual(state.tombstones, [
    { deleteId: d.id, active: true, cancelledBy: [] },
  ]);
});

test("merge is idempotent and self-merge is a no-op", () => {
  const a = new Archive("A");
  a.update(DOC, "v1");
  const d = a.delete(DOC);
  a.restore(DOC, d.id);
  a.update(DOC, "v2");

  const b = new Archive("B").merge(a.allEvents());
  const before = b.documentState(DOC);
  const size = b.size;

  b.merge(a.allEvents()); // full re-merge
  b.merge(a.allEvents().slice(0, 2)); // subset re-merge
  b.merge(b); // self merge
  assert.equal(b.size, size);
  assert.deepEqual(b.documentState(DOC), before);
});

test("merge is commutative and associative across replicas", () => {
  const a = new Archive("A");
  a.update(DOC, "v1");
  const snap = a.allEvents();
  const b = new Archive("B").merge(snap);
  const c = new Archive("C").merge(snap);
  b.delete(DOC); // never restored
  const cDelete = c.delete(DOC);
  c.restore(DOC, cDelete.id);
  c.update(DOC, "from-C");

  const left = new Archive("L").merge(a.allEvents()).merge(b.allEvents()).merge(c.allEvents());
  const right = new Archive("R").merge(c.allEvents()).merge(b.allEvents()).merge(a.allEvents());
  assert.deepEqual(left.documentState(DOC), right.documentState(DOC));
  assert.equal(left.documentState(DOC).status, "deleted"); // b's delete unrestored
});

test("all permutations of a short event log converge on tombstones and content provenance", () => {
  const u1 = update("u1", "v1", 1);
  const u2 = update("u2", "v2", 2); // concurrent with u1, wins LWW
  const d1 = del("d1", 3, ["u1", "u2"]);
  const r1 = restore("r1", "d1", 4, ["d1"]);
  const r2 = restore("r2", "d1", 5, ["d1"]); // concurrent restore -> second branch
  const u3 = update("u3", "v3", 6, ["r1"]); // extends r1's branch only
  const log: ArchiveEvent[] = [u1, u2, d1, r1, r2, u3];

  const expected: DocumentState = {
    doc: DOC,
    status: "active",
    tombstones: [{ deleteId: "d1", active: false, cancelledBy: ["r1", "r2"] }],
    branches: [
      { rootRestoreId: "r1", content: "v3", contentFrom: "u3" },
      { rootRestoreId: "r2", content: "v2", contentFrom: "u2" },
    ],
  };

  const orders = permutations(log);
  assert.equal(orders.length, 720);
  for (const order of orders) {
    const replica = new Archive("P");
    for (const event of order) replica.merge([event]);
    assert.equal(replica.size, log.length);
    assert.deepEqual(replica.documentState(DOC), expected);
    // Idempotency under re-delivery in any order.
    replica.merge(order);
    assert.equal(replica.size, log.length);
    assert.deepEqual(replica.documentState(DOC), expected);
  }
});

test("permutations with an uncancelled tombstone stay deleted in every order", () => {
  const u1 = update("u1", "v1", 1);
  const d1 = del("d1", 2, ["u1"]);
  const d2 = del("d2", 3, ["u1"]); // concurrent delete
  const r1 = restore("r1", "d1", 4, ["d1"]); // only cancels d1
  const u2 = update("u2", "late", 5, ["r1"]);
  const log: ArchiveEvent[] = [u1, d1, d2, r1, u2];

  const expected: DocumentState = {
    doc: DOC,
    status: "deleted",
    tombstones: [
      { deleteId: "d1", active: false, cancelledBy: ["r1"] },
      { deleteId: "d2", active: true, cancelledBy: [] },
    ],
    branches: [],
  };

  for (const order of permutations(log)) {
    assert.deepEqual(stateOf(order), expected);
  }
});
