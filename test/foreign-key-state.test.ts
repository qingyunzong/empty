import assert from "node:assert/strict";
import test from "node:test";

import ForeignKeyState, {
  ForeignKeyTracker,
  ForeignKeyValidator,
  createForeignKeyState,
} from "../index.ts";

test("a missing parent is pending and a timely parent revokes the candidate", () => {
  const fk = new ForeignKeyState({ window: 5 });

  assert.equal(
    fk.applyChild({ key: "c1", parentKey: "p1", version: 1 }),
    true,
  );
  assert.deepEqual(fk.getPending(), [
    {
      childKey: "c1",
      parentKey: "p1",
      childVersion: 1,
      openedAt: 1,
      deadline: 6,
      deadlineWatermark: 6,
      status: "pending",
    },
  ]);
  assert.equal(fk.getViolations().length, 0);

  fk.applyParent({ key: "p1", version: 2 });

  assert.equal(fk.pending.length, 0);
  assert.equal(fk.violations.length, 0);
  assert.equal(fk.snapshot().children[0]?.status, "satisfied");

  const kinds = fk.history.map((event) => event.kind);
  assert.ok(kinds.includes("pending"));
  assert.ok(kinds.includes("pending-revoked"));
  assert.equal(kinds.includes("violation"), false);
});

test("a deadline closes the candidate into a final violation at the watermark", () => {
  const fk = createForeignKeyState({ window: 5 });
  fk.upsertChild("c1", "p1", 1);

  assert.equal(fk.advanceWatermark(5).length, 0);
  const finalized = fk.advanceWatermark(6);

  assert.equal(finalized.length, 1);
  assert.equal(finalized[0]?.childKey, "c1");
  assert.equal(finalized[0]?.parentKey, "p1");
  assert.equal(finalized[0]?.childVersion, 1);
  assert.equal(finalized[0]?.deadline, 6);
  assert.equal(finalized[0]?.detectedVersion, 6);
  assert.equal(finalized[0]?.finalizedVersion, 6);
  assert.equal(finalized[0]?.version, 6);
  assert.equal(finalized[0]?.reason, "missing-parent");
  assert.equal(finalized[0]?.status, "open");
});

test("a candidate remains revocable until the watermark actually closes it", () => {
  const fk = new ForeignKeyState({ window: 5 });
  fk.applyChild({ key: "c1", parentKey: "p1", version: 1 });
  fk.applyParent({ key: "p1", version: 7 });

  assert.equal(fk.getPending().length, 0);
  assert.equal(fk.getViolations().length, 0);
  assert.equal(fk.getActiveViolations().length, 0);
});

test("a parent arriving after closure repairs with a new event, not a rewrite", () => {
  const fk = new ForeignKeyState({ window: 2 });
  fk.applyChild({ key: "c1", parentKey: "p1", version: 1 });
  fk.advanceWatermark(3);

  const [original] = fk.getViolations();
  assert.ok(original);
  const violationEvent = fk.history.find(
    (event) => event.kind === "violation",
  );
  assert.ok(violationEvent);
  const historyLengthBeforeRepair = fk.history.length;

  fk.applyParent({ key: "p1", version: 4 });

  const [repaired] = fk.getViolations();
  assert.ok(repaired);
  assert.equal(fk.getViolations().length, 1, "history is retained");
  assert.equal(repaired.id, original.id);
  assert.equal(repaired.finalizedVersion, original.finalizedVersion);
  assert.equal(repaired.childVersion, original.childVersion);
  assert.equal(repaired.status, "resolved");
  assert.equal(repaired.resolvedBy, "parent-arrived");
  assert.equal(repaired.resolvedVersion, 4);
  assert.equal(fk.getActiveViolations().length, 0);

  assert.equal(fk.history.length, historyLengthBeforeRepair + 2);
  assert.deepEqual(
    fk.history.find((event) => event.kind === "violation"),
    violationEvent,
    "the original violation event is unchanged",
  );
  assert.ok(
    fk.history.some(
      (event) =>
        event.kind === "repair" && event.violationId === original.id,
    ),
  );
});

test("deleting a parent violates every child in its current set", () => {
  const fk = new ForeignKeyState({ window: 10 });
  fk.upsertParent("p1", 1);
  fk.upsertChild("c1", "p1", 2);
  fk.upsertChild("c2", "p1", 3);
  fk.upsertChild("c3", "other", 4);

  fk.deleteParent("p1", 5);

  const violations = fk.getActiveViolations();
  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((violation) => violation.childKey).sort(),
    ["c1", "c2"],
  );
  for (const violation of violations) {
    assert.equal(violation.reason, "parent-deleted");
    assert.equal(violation.parentVersion, 5);
    assert.equal(violation.finalizedVersion, 5);
  }
  assert.equal(fk.snapshot().parents[0]?.deleted, true);
});

test("parent deletion also finalizes children still inside their grace window", () => {
  const fk = new ForeignKeyState({ window: 100 });
  fk.applyChild({ key: "c1", parentKey: "p1", version: 1 });
  assert.equal(fk.getPending().length, 1);

  fk.deleteParent("p1", 2);

  assert.equal(fk.getPending().length, 0);
  const [violation] = fk.getActiveViolations();
  assert.ok(violation);
  assert.equal(violation.reason, "parent-deleted");
  assert.equal(violation.deadline, 101);
  assert.equal(violation.detectedVersion, 2);
  assert.equal(violation.parentVersion, 2);
});

test("an out-of-order delete cannot invalidate a newer parent insert", () => {
  const fk = new ForeignKeyState({ window: 10 });
  fk.upsertParent("p1", 5);
  const childVersion = 6;
  fk.upsertChild("c1", "p1", childVersion);
  assert.equal(fk.getActiveViolations().length, 0);

  fk.deleteParent("p1", 4);

  assert.equal(fk.getActiveViolations().length, 0);
  assert.equal(fk.snapshot().parents[0]?.deleted, false);
  assert.equal(fk.snapshot().children[0]?.status, "satisfied");
});

test("a child insert older than a deletion becomes a parent-deleted violation", () => {
  const fk = new ForeignKeyState({ window: 10 });
  fk.deleteParent("p1", 3);

  fk.applyChild({ key: "c1", parentKey: "p1", version: 5 });

  const [violation] = fk.getActiveViolations();
  assert.ok(violation);
  assert.equal(violation.reason, "parent-deleted");
  assert.equal(violation.childVersion, 5);
  assert.equal(violation.finalizedVersion, 5);
  assert.equal(fk.getPending().length, 0);
});

test("closing the window finalizes future deadlines and makes later gaps immediate", () => {
  const fk = new ForeignKeyState({ window: 100 });
  fk.upsertChild("c1", "p1", 1);
  assert.equal(fk.getPending()[0]?.deadline, 101);

  const closed = fk.closeWindow(5);
  assert.equal(fk.isClosed(), true);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.finalizedVersion, 5);
  assert.equal(closed[0]?.deadline, 101);
  assert.equal(fk.getPending().length, 0);

  fk.applyChild({ key: "c2", parentKey: "p2", version: 6 });
  assert.deepEqual(
    fk
      .getActiveViolations()
      .map((violation) => [violation.childKey, violation.finalizedVersion]),
    [
      ["c1", 5],
      ["c2", 6],
    ],
  );
  assert.equal(fk.getPending().length, 0);

  fk.applyParent({ key: "p1", version: 7 });
  fk.applyParent({ key: "p2", version: 8 });
  assert.equal(fk.getActiveViolations().length, 0);
  assert.equal(fk.getViolations().length, 2);
  assert.equal(
    fk.getViolations().every((violation) => violation.status === "resolved"),
    true,
  );
});

test("an early close still reports a final version no older than the child", () => {
  const fk = new ForeignKeyState({ window: 100 });
  fk.applyChild({ key: "c1", parentKey: "p1", version: 5 });
  // The watermark is still 0, but closure cannot make the violation older
  // than the child version it describes.
  const [violation] = fk.closeWindow();
  assert.ok(violation);
  assert.equal(violation.childVersion, 5);
  assert.equal(violation.version, 5);
  assert.equal(violation.finalVersion, 5);
  assert.equal(violation.violatingVersion, 5);
  assert.equal(violation.deadline, 105);
});

test("re-pointing or deleting a child resolves its active violation", () => {
  const fk = new ForeignKeyState({ window: 0 });
  fk.upsertParent("p1", 1);
  fk.upsertParent("p2", 2);
  fk.upsertChild("c1", "p1", 3);
  fk.deleteParent("p1", 4);
  assert.equal(fk.getActiveViolations().length, 1);

  fk.upsertChild("c1", "p2", 5);
  assert.equal(fk.getActiveViolations().length, 0);
  assert.equal(fk.snapshot().children[0]?.status, "satisfied");
  const [resolvedByMove] = fk.getViolations();
  assert.equal(resolvedByMove?.resolvedBy, "child-updated");
  assert.equal(resolvedByMove?.resolvedVersion, 5);

  fk.deleteParent("p2", 6);
  assert.equal(fk.getActiveViolations().length, 1);
  fk.deleteChild("c1", 7);
  assert.equal(fk.getActiveViolations().length, 0);
  const latest = fk.getViolations().at(-1);
  assert.equal(latest?.resolvedBy, "child-deleted");
});

test("explicit deadlines and generic apply dispatch are supported", () => {
  const fk = new ForeignKeyState();
  fk.apply({
    entity: "parent",
    key: "p1",
    version: 1,
  });
  fk.apply({
    entity: "child",
    childKey: "c1",
    parentId: "missing",
    version: 2,
    deadlineWatermark: 20,
  });
  fk.apply({ type: "child-upsert", key: "c2", parentId: "p1", at: 3 });

  assert.equal(fk.getPending().length, 1);
  assert.equal(fk.getPending()[0]?.deadline, 20);
  assert.equal(fk.snapshot().children.length, 2);

  fk.advanceWatermark(20);
  assert.equal(fk.getActiveViolations().length, 1);
  assert.equal(fk.getActiveViolations()[0]?.childKey, "c1");
  assert.equal(fk.version, 3);
});

test("auto versions advance past explicit versions and watermarks", () => {
  const fk = new ForeignKeyState({ watermark: 8 });
  fk.upsertParent("p1", 3);
  fk.upsertChild("c1", "p1");

  assert.equal(fk.version, 9);
  assert.equal(fk.snapshot().children[0]?.version, 9);
  assert.equal(fk.getActiveViolations().length, 0);
});

test("aliases and factory helpers expose the same component", () => {
  assert.equal(ForeignKeyTracker, ForeignKeyState);
  assert.equal(ForeignKeyValidator, ForeignKeyState);
  assert.ok(createForeignKeyState() instanceof ForeignKeyState);
  assert.ok(new ForeignKeyState(5) instanceof ForeignKeyState);
  const positional = new ForeignKeyState(5, 2);
  assert.equal(positional.watermark, 2);
});
