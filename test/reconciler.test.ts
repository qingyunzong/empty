import assert from "node:assert/strict";
import test from "node:test";

import {
  ObjectReconciler,
  ReconciliationInputError,
  reconcile,
  type InventorySnapshot,
  type ObjectNotification,
} from "../index.ts";

function create(
  eventId: string,
  key: string,
  eventTime: number,
  extra: Partial<ObjectNotification> = {},
): ObjectNotification {
  return { eventId, key, operation: "create", eventTime, ...extra };
}

function remove(
  eventId: string,
  key: string,
  eventTime: number,
): ObjectNotification {
  return { eventId, key, operation: "delete", eventTime };
}

function snapshot(
  snapshotId: string,
  boundary: number,
  objects: string[],
): InventorySnapshot {
  return { snapshotId, boundary, objects };
}

test("a covered create that is present in inventory needs no correction", () => {
  const result = reconcile(
    [create("e1", "bucket/a", 10)],
    [snapshot("s1", 20, ["bucket/a"])],
  );

  assert.equal(result.corrections.length, 0);
  assert.equal(result.pending.length, 0);
  assert.deepEqual(result.objects, [
    {
      key: "bucket/a",
      exists: true,
      lastEventId: "e1",
      lastEventTime: 10,
      lastOperation: "create",
      lastSnapshotId: "s1",
      lastSnapshotBoundary: 20,
      pending: false,
    },
  ]);
});

test("deletes only when the create is covered by the snapshot boundary", () => {
  const result = reconcile(
    [create("e1", "bucket/a", 10)],
    [snapshot("s-early", 5, []), snapshot("s-late", 20, [])],
  );

  assert.equal(result.corrections.length, 1);
  const correction = result.corrections[0]!;
  assert.equal(correction.type, "delete");
  assert.equal(correction.key, "bucket/a");
  assert.equal(correction.at, 20);
  assert.equal(correction.expected, "present");
  assert.equal(correction.observed, "absent");
  assert.equal(correction.action, "delete");
  assert.equal(correction.evidence.notifications.length, 1);
  assert.equal(correction.evidence.notifications[0]!.eventId, "e1");
  assert.deepEqual(correction.evidence.snapshots, [
    { snapshotId: "s-late", boundary: 20, present: false },
  ]);
  assert.equal(result.objects[0]!.exists, false);
  assert.equal(result.pending.length, 0);
});

test("a create newer than the snapshot stays pending and cannot be deleted", () => {
  const result = reconcile(
    [create("e1", "bucket/a", 30)],
    [snapshot("s1", 20, [])],
  );

  assert.equal(result.corrections.length, 0);
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0]!.key, "bucket/a");
  assert.equal(result.pending[0]!.reason, "newer-than-snapshot");
  assert.equal(result.pending[0]!.exists, true);
  assert.equal(result.objects[0]!.exists, true);
});

test("a readableAfter watermark prevents premature deletion", () => {
  const notification = create("e1", "bucket/a", 10, { readableAfter: 100 });

  const early = reconcile(
    [notification],
    [snapshot("s1", 20, [])],
  );
  assert.equal(early.corrections.length, 0);
  assert.equal(early.pending.length, 1);
  assert.equal(early.pending[0]!.reason, "awaiting-visibility");
  assert.equal(early.objects[0]!.exists, true);

  const late = reconcile(
    [notification],
    [snapshot("s1", 20, []), snapshot("s2", 120, [])],
  );
  assert.equal(late.corrections.length, 1);
  assert.equal(late.corrections[0]!.type, "delete");
  assert.equal(late.corrections[0]!.at, 120);
  assert.equal(late.pending.length, 0);
  assert.equal(late.objects[0]!.exists, false);
});

test("duplicate notification deliveries are idempotent", () => {
  const notification = create("e1", "bucket/a", 10);
  const reconciler = new ObjectReconciler();

  assert.equal(reconciler.ingestNotification(notification), true);
  assert.equal(
    reconciler.ingestNotification({ ...notification, receivedAt: 50 }),
    false,
  );
  reconciler.ingestSnapshot(snapshot("s1", 20, []));

  const result = reconciler.reconcile();
  assert.equal(reconciler.notificationCount, 1);
  assert.equal(result.corrections.length, 1);
  assert.equal(result.corrections[0]!.evidence.notifications.length, 1);
});

test("duplicate copies merge to deterministic evidence", () => {
  const early = create("e1", "bucket/a", 10, { receivedAt: 5 });
  const late = create("e1", "bucket/a", 10, { receivedAt: 50 });
  const snapshots = [
    { snapshotId: "s1", boundary: 20, objects: [], capturedAt: 7 },
  ];

  const left = reconcile([early, late], snapshots);
  const right = reconcile([late, early], snapshots);
  assert.equal(JSON.stringify(left), JSON.stringify(right));
  assert.equal(
    left.corrections[0]!.evidence.notifications[0]!.receivedAt,
    5,
  );
  assert.equal(left.corrections[0]!.evidence.snapshots[0]!.capturedAt, 7);
});

test("a late duplicate create does not resurrect a deleted object", () => {
  const notifications = [
    create("create-1", "bucket/a", 10),
    remove("delete-1", "bucket/a", 20),
    create("create-1", "bucket/a", 10, { receivedAt: 90 }),
  ];
  const result = reconcile(notifications, [snapshot("s1", 30, [])]);

  assert.equal(result.corrections.length, 0);
  assert.equal(result.pending.length, 0);
  assert.equal(result.objects[0]!.exists, false);
  assert.equal(result.objects[0]!.lastEventId, "delete-1");
});

test("a delete older than a snapshot is confirmed, not replayed last", () => {
  const result = reconcile(
    [remove("d1", "bucket/a", 20), create("c1", "bucket/a", 10)],
    [snapshot("s1", 30, [])],
  );

  assert.equal(result.corrections.length, 0);
  assert.equal(result.pending.length, 0);
  assert.equal(result.objects[0]!.exists, false);
});

test("inventory present after a covered delete produces a restore correction", () => {
  const result = reconcile(
    [create("c1", "bucket/a", 10), remove("d1", "bucket/a", 15)],
    [snapshot("s1", 20, ["bucket/a"])],
  );

  assert.equal(result.corrections.length, 1);
  const correction = result.corrections[0]!;
  assert.equal(correction.type, "restore");
  assert.equal(correction.action, "upsert");
  assert.equal(correction.expected, "absent");
  assert.equal(correction.observed, "present");
  assert.deepEqual(
    correction.evidence.notifications.map((item) => item.eventId),
    ["c1", "d1"],
  );
  assert.equal(correction.evidence.snapshots[0]!.entry?.key, "bucket/a");
  assert.equal(result.objects[0]!.exists, true);
});

test("an inventory-only object is adopted with inventory evidence", () => {
  const result = reconcile([], [snapshot("s1", 20, ["bucket/a"])]);

  assert.equal(result.corrections.length, 1);
  const correction = result.corrections[0]!;
  assert.equal(correction.type, "create");
  assert.equal(correction.reason, "snapshot-only-object");
  assert.equal(correction.evidence.notifications.length, 0);
  assert.deepEqual(correction.evidence.snapshots, [
    {
      snapshotId: "s1",
      boundary: 20,
      present: true,
      entry: { key: "bucket/a" },
    },
  ]);
  assert.equal(result.objects[0]!.exists, true);
});

test("absence between two inventory snapshots generates a delete", () => {
  const result = reconcile(
    [],
    [snapshot("s1", 10, ["bucket/a"]), snapshot("s2", 20, [])],
  );

  assert.deepEqual(
    result.corrections.map((correction) => correction.type),
    ["create", "delete"],
  );
  const correction = result.corrections[1]!;
  assert.equal(correction.type, "delete");
  assert.equal(correction.evidence.notifications.length, 0);
  assert.deepEqual(
    correction.evidence.snapshots.map((item) => ({
      snapshotId: item.snapshotId,
      present: item.present,
    })),
    [
      { snapshotId: "s1", present: true },
      { snapshotId: "s2", present: false },
    ],
  );
  assert.equal(result.objects[0]!.exists, false);
});

test("an object that reappears after deletion is restored", () => {
  const result = reconcile(
    [],
    [
      snapshot("s1", 10, ["bucket/a"]),
      snapshot("s2", 20, []),
      snapshot("s3", 30, ["bucket/a"]),
    ],
  );

  assert.deepEqual(
    result.corrections.map((correction) => correction.type),
    ["create", "delete", "restore"],
  );
  assert.equal(result.corrections[1]!.type, "delete");
  assert.equal(result.corrections[2]!.type, "restore");
  assert.equal(result.corrections[2]!.at, 30);
  assert.equal(result.objects[0]!.exists, true);
  assert.equal(result.objects[0]!.lastSnapshotId, "s3");
});

test("a notification after the last snapshot stays pending", () => {
  const result = reconcile(
    [create("c1", "bucket/a", 10), remove("d1", "bucket/a", 30)],
    [snapshot("s1", 20, ["bucket/a"])],
  );

  assert.equal(result.corrections.length, 0);
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0]!.reason, "newer-than-snapshot");
  assert.equal(result.pending[0]!.notification.eventId, "d1");
  assert.equal(result.pending[0]!.exists, false);
  assert.equal(result.objects[0]!.exists, false);
});

test("no snapshots means every notification is pending", () => {
  const result = reconcile(
    [create("c1", "bucket/b", 10), remove("d1", "bucket/a", 20)],
    [],
  );

  assert.equal(result.corrections.length, 0);
  assert.equal(result.pending.length, 2);
  assert.deepEqual(
    result.pending.map((item) => [item.key, item.reason]),
    [
      ["bucket/a", "no-snapshot"],
      ["bucket/b", "no-snapshot"],
    ],
  );
});

test("snapshot entries can be strings and can carry versions", () => {
  const result = reconcile(
    [create("c1", "bucket/a", 10, { version: "v1" })],
    [
      {
        snapshotId: "s1",
        boundary: 20,
        objects: [
          { key: "bucket/a", version: "v2", etag: "etag-2", size: 4 },
        ],
      },
    ],
  );

  assert.equal(result.corrections.length, 0);
  assert.equal(result.objects[0]!.version, "v2");
  assert.equal(result.objects[0]!.exists, true);

  const stringEntries = reconcile([], [snapshot("s2", 30, ["bucket/b"])]);
  assert.equal(stringEntries.objects[0]!.key, "bucket/b");
});

test("duplicate snapshots are idempotent", () => {
  const reconciler = new ObjectReconciler();
  const input = snapshot("s1", 20, ["bucket/a"]);

  assert.equal(reconciler.ingestSnapshot(input), true);
  assert.equal(reconciler.ingestSnapshot(input), false);
  assert.equal(reconciler.snapshotCount, 1);
  assert.equal(reconciler.reconcile().corrections.length, 1);
});

test("conflicting duplicate ids are rejected regardless of order", () => {
  const first = create("e1", "bucket/a", 10);
  const conflicting = create("e1", "bucket/b", 10);

  const left = new ObjectReconciler();
  left.ingestNotification(first);
  assert.throws(
    () => left.ingestNotification(conflicting),
    ReconciliationInputError,
  );

  const right = new ObjectReconciler();
  right.ingestNotification(conflicting);
  assert.throws(
    () => right.ingestNotification(first),
    ReconciliationInputError,
  );
});

test("boundaryInclusive=false excludes an event exactly on the boundary", () => {
  const notifications = [create("e1", "bucket/a", 20)];
  const snapshots = [snapshot("s1", 20, [])];

  const inclusive = reconcile(notifications, snapshots);
  assert.equal(inclusive.corrections.length, 1);

  const exclusive = reconcile(notifications, snapshots, {
    boundaryInclusive: false,
  });
  assert.equal(exclusive.corrections.length, 0);
  assert.equal(exclusive.pending[0]!.reason, "newer-than-snapshot");
});

test("every replay order of the same facts produces the same result", () => {
  const facts: Array<
    | { kind: "notification"; value: ObjectNotification }
    | { kind: "snapshot"; value: InventorySnapshot }
  > = [
    { kind: "notification", value: create("c-a1", "bucket/a", 10) },
    { kind: "notification", value: create("c-a2", "bucket/a", 15) },
    { kind: "notification", value: create("c-b1", "bucket/b", 30) },
    { kind: "snapshot", value: snapshot("s1", 12, ["bucket/a"]) },
    {
      kind: "snapshot",
      value: {
        snapshotId: "s2",
        boundary: 25,
        objects: ["bucket/b"],
      },
    },
  ];

  const expected = replay(facts);
  for (const order of permutations(facts)) {
    assert.equal(
      JSON.stringify(replay(order)),
      JSON.stringify(expected),
      `replay order differs: ${order.map((fact) => fact.value).map(String)}`,
    );
  }
});

function replay(
  facts: Array<
    | { kind: "notification"; value: ObjectNotification }
    | { kind: "snapshot"; value: InventorySnapshot }
  >,
) {
  const reconciler = new ObjectReconciler();
  for (const fact of facts) {
    if (fact.kind === "notification") {
      reconciler.addNotification(fact.value);
    } else {
      reconciler.addSnapshot(fact.value);
    }
  }
  return reconciler.reconcile();
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const head = items[index]!;
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) {
      result.push([head, ...tail]);
    }
  }
  return result;
}
