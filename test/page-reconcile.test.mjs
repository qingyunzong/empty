import test from "node:test";
import assert from "node:assert/strict";

import {
  DeltaFormatError,
  MemoryDeltaStore,
  applyDeltaChanges,
  compareServerVersions,
  parseDeltaPage,
  reconcileChange,
} from "../dist/index.js";

const entity = (id, version, extra = {}) => ({
  "@odata.id": id,
  version,
  ...extra,
});

test("parseDeltaPage reads links, updates, and removed tombstones", () => {
  const raw = {
    "@odata.context": "https://example.test/$metadata#Things",
    "@odata.nextLink": " page-2 ",
    value: [
      entity("Things(1)", 1, { Name: "one" }),
      {
        "@odata.id": "Things(2)",
        version: 9,
        "@removed": { reason: "deleted" },
      },
    ],
  };

  const page = parseDeltaPage(raw);

  assert.equal(page.nextLink, "page-2");
  assert.equal(page.deltaLink, undefined);
  assert.equal(page.changes.length, 2);
  assert.deepEqual(page.changes[0], {
    kind: "update",
    id: "Things(1)",
    version: 1,
    entity: raw.value[0],
  });
  assert.deepEqual(page.changes[1], {
    kind: "removed",
    id: "Things(2)",
    version: 9,
    reason: "deleted",
  });
});

test("parseDeltaPage supports deltaLink-only pages and omits absent fields", () => {
  const page = parseDeltaPage({
    value: [{ "@odata.id": "Things(1)", Name: "no version" }],
    "@odata.deltaLink": "delta-1",
  });

  assert.equal(page.deltaLink, "delta-1");
  assert.equal(Object.hasOwn(page.changes[0], "version"), false);
});

test("parseDeltaPage rejects malformed pages and entries", () => {
  assert.throws(
    () => parseDeltaPage({ nextLink: "x" }),
    (error) =>
      error instanceof DeltaFormatError && error.code === "INVALID_PAGE",
  );
  assert.throws(
    () => parseDeltaPage({ value: [{ Name: "missing id" }] }),
    DeltaFormatError,
  );
  assert.throws(
    () => parseDeltaPage({ value: [null] }),
    DeltaFormatError,
  );
});

test("compareServerVersions compares integers, numeric ETags, and text", () => {
  assert.equal(compareServerVersions(10, 9), 1);
  assert.equal(compareServerVersions("10", "9"), 1);
  assert.equal(compareServerVersions('W/"10"', 'W/"9"'), 1);
  assert.equal(compareServerVersions('W/"9"', 'W/"10"'), -1);
  assert.equal(compareServerVersions("2026-01-01", "2025-12-31"), 1);
  assert.equal(compareServerVersions(7, 7), 0);
});

test("stale updates and duplicate versions are ignored", () => {
  const store = new MemoryDeltaStore();

  const first = store.commit(
    "Things",
    [{ kind: "update", id: "Things(1)", version: 2, entity: entity("Things(1)", 2) }],
    { deltaLink: "d1" },
  );
  assert.equal(first.inserted, 1);

  const stale = store.commit(
    "Things",
    [{ kind: "update", id: "Things(1)", version: 1, entity: entity("Things(1)", 1) }],
    { deltaLink: "d2" },
  );
  assert.equal(stale.applied, 0);
  assert.equal(stale.ignored, 1);
  assert.equal(store.getRecord("Things", "Things(1)").version, 2);

  const duplicate = store.commit(
    "Things",
    [{ kind: "update", id: "Things(1)", version: 2, entity: entity("Things(1)", 2) }],
    { deltaLink: "d3" },
  );
  assert.equal(duplicate.applied, 0);
  assert.equal(store.getRecord("Things", "Things(1)").deleted, false);
});

test("a late tombstone cannot delete a newer recreated generation", () => {
  const store = new MemoryDeltaStore();

  store.commit(
    "Things",
    [{ kind: "removed", id: "Things(1)", version: 5, reason: "deleted" }],
    { deltaLink: "d1" },
  );
  assert.equal(store.getRecord("Things", "Things(1)").deleted, true);

  const recreate = store.commit(
    "Things",
    [
      {
        kind: "update",
        id: "Things(1)",
        version: 8,
        entity: entity("Things(1)", 8, { Name: "reborn" }),
      },
    ],
    { deltaLink: "d2" },
  );
  assert.equal(recreate.resurrected, 1);
  assert.equal(store.getRecord("Things", "Things(1)").deleted, false);

  const lateTombstone = store.commit(
    "Things",
    [{ kind: "removed", id: "Things(1)", version: 6, reason: "deleted" }],
    { deltaLink: "d3" },
  );
  assert.equal(lateTombstone.applied, 0);
  assert.equal(lateTombstone.ignored, 1);

  const record = store.getRecord("Things", "Things(1)");
  assert.equal(record.deleted, false);
  assert.equal(record.version, 8);
  assert.equal(record.entity.Name, "reborn");

  const newerTombstone = store.commit(
    "Things",
    [{ kind: "removed", id: "Things(1)", version: 9, reason: "deleted" }],
    { deltaLink: "d4" },
  );
  assert.equal(newerTombstone.removed, 1);
  assert.equal(store.getRecord("Things", "Things(1)").deleted, true);
});

test("an older update cannot resurrect an entity whose tombstone arrived first", () => {
  const store = new MemoryDeltaStore();
  store.commit(
    "Things",
    [{ kind: "removed", id: "A", version: 5 }],
    { deltaLink: "d1" },
  );

  const stale = store.commit(
    "Things",
    [{ kind: "update", id: "A", version: 4, entity: entity("A", 4) }],
    { deltaLink: "d2" },
  );
  assert.equal(stale.applied, 0);
  assert.equal(store.getRecord("Things", "A").deleted, true);

  const newer = store.commit(
    "Things",
    [{ kind: "update", id: "A", version: 6, entity: entity("A", 6) }],
    { deltaLink: "d3" },
  );
  assert.equal(newer.resurrected, 1);
  assert.equal(store.getRecord("Things", "A").deleted, false);
});

test("tombstones win an equal-version tie but cannot resurrect over one", () => {
  const store = new MemoryDeltaStore();
  store.commit(
    "Things",
    [{ kind: "update", id: "A", version: 5, entity: entity("A", 5) }],
    { deltaLink: "d1" },
  );

  const tieDelete = store.commit(
    "Things",
    [{ kind: "removed", id: "A", version: 5 }],
    { deltaLink: "d2" },
  );
  assert.equal(tieDelete.removed, 1);
  assert.equal(store.getRecord("Things", "A").deleted, true);

  const tieUpdate = store.commit(
    "Things",
    [{ kind: "update", id: "A", version: 5, entity: entity("A", 5) }],
    { deltaLink: "d3" },
  );
  assert.equal(tieUpdate.applied, 0);
  assert.equal(store.getRecord("Things", "A").deleted, true);
});

test("an unversioned tombstone cannot remove a versioned record", () => {
  const store = new MemoryDeltaStore();
  store.commit(
    "Things",
    [{ kind: "update", id: "A", version: 7, entity: entity("A", 7) }],
    { deltaLink: "d1" },
  );

  const outcome = reconcileChange(
    store.getRecord("Things", "A"),
    { kind: "removed", id: "A", reason: "deleted" },
  );
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "missing-version");
});

test("applyDeltaChanges is pure and reports precise statistics", () => {
  const original = new Map([
    ["A", { id: "A", version: 1, deleted: false, entity: entity("A", 1) }],
    ["B", { id: "B", version: 1, deleted: true, removalReason: "deleted" }],
  ]);

  const result = applyDeltaChanges(original, [
    { kind: "update", id: "A", version: 2, entity: entity("A", 2) },
    { kind: "update", id: "A", version: 1, entity: entity("A", 1) },
    {
      kind: "update",
      id: "B",
      version: 3,
      entity: entity("B", 3, { Name: "back" }),
    },
    { kind: "removed", id: "C", version: 4, reason: "deleted" },
  ]);

  assert.equal(original.get("A").version, 1);
  assert.equal(original.has("C"), false);
  assert.equal(result.stats.received, 4);
  assert.equal(result.stats.applied, 3);
  assert.equal(result.stats.ignored, 1);
  assert.equal(result.stats.updated, 2);
  assert.equal(result.stats.removed, 1);
  assert.equal(result.stats.resurrected, 1);
  assert.equal(result.records.get("B").deleted, false);
  assert.equal(result.records.get("C").deleted, true);
});

test("a mid-batch failure does not expose any record or cursor change", () => {
  let comparisons = 0;
  const store = new MemoryDeltaStore({
    compareVersions: (incoming, existing) => {
      comparisons += 1;
      if (comparisons === 2) {
        throw new Error("comparator failed");
      }
      return Number(incoming) - Number(existing);
    },
  });

  store.commit(
    "Things",
    [
      { kind: "update", id: "A", version: 1, entity: entity("A", 1) },
      { kind: "update", id: "B", version: 1, entity: entity("B", 1) },
    ],
    { deltaLink: "D0" },
  );

  assert.throws(
    () =>
      store.commit(
        "Things",
        [
          { kind: "update", id: "A", version: 2, entity: entity("A", 2) },
          { kind: "update", id: "B", version: 2, entity: entity("B", 2) },
        ],
        { deltaLink: "D1" },
      ),
    /comparator failed/,
  );

  assert.equal(store.getCursor("Things").deltaLink, "D0");
  assert.equal(store.getRecord("Things", "A").version, 1);
  assert.equal(store.getRecord("Things", "B").version, 1);
});
