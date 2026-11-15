import assert from "node:assert/strict";
import test from "node:test";
import {
  CdcChangeMerger,
  mergeCdcRows,
  UpdateMaskDecoder,
  type CdcChangeRow,
} from "../index.ts";

const schema = {
  captureInstance: "dbo_Items",
  columns: [
    { ordinal: 1, name: "id", type: "int" },
    { ordinal: 2, name: "name", type: "nvarchar" },
    { ordinal: 3, name: "qty", type: "int" },
    { ordinal: 4, name: "note", type: "nvarchar" },
  ],
};

function lsn(value: number): Uint8Array {
  return Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, value]);
}

function beforeRow(value = 10, mask: number | Uint8Array | null = 0): CdcChangeRow {
  return {
    "__$start_lsn": lsn(value),
    "__$seqval": lsn(1),
    "__$operation": 3,
    "__$update_mask": mask,
    id: 7,
    name: "old",
    qty: 2,
    note: "keep",
  };
}

function afterRow(value = 10, mask: number | Uint8Array | null = 0b1010): CdcChangeRow {
  return {
    "__$start_lsn": lsn(value),
    "__$seqval": lsn(1),
    "__$operation": 4,
    "__$update_mask": mask,
    id: 7,
    name: "new",
    qty: 2,
    note: "changed",
  };
}

test("pairs before/after rows and decodes the after-image mask", () => {
  const merger = new CdcChangeMerger({ schema });
  const first = merger.ingest(beforeRow());
  assert.equal(first.changes.length, 0);
  assert.equal(first.pending.length, 1);
  assert.deepEqual(first.pending[0].missing, ["after"]);

  const second = merger.ingest(afterRow());
  assert.equal(second.updates.length, 1);
  const update = second.updates[0];
  assert.equal(update.kind, "update");
  assert.equal(update.captureInstance, "dbo_Items");
  assert.deepEqual(update.changedColumns, ["name", "note"]);
  assert.deepEqual(update.updatedColumns, ["name", "note"]);
  assert.deepEqual(update.ordinals, [2, 4]);
  assert.deepEqual(update.beforeValues, { id: 7, name: "old", qty: 2, note: "keep" });
  assert.deepEqual(update.afterValues, { id: 7, name: "new", qty: 2, note: "changed" });
  assert.deepEqual(update.mergedValues, {
    id: 7,
    name: "new",
    qty: 2,
    note: "changed",
  });
  assert.equal(second.pending.length, 0);
});

test("pairs out-of-order arrival without publishing the half early", () => {
  const merger = new CdcChangeMerger({ schema });
  assert.equal(merger.ingest(afterRow()).changes.length, 0);
  const result = merger.ingest(beforeRow());
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, "update");
});

test("accepts a schema directly and string operation names", () => {
  const merger = new CdcChangeMerger(schema);
  merger.ingest({
    ...beforeRow(15),
    "__$operation": "UPDATE BEFORE",
  });
  const result = merger.ingest({
    ...afterRow(15),
    "__$operation": "4",
  });
  assert.equal(result.updates.length, 1);
  assert.deepEqual(merger.decode("0x0a"), ["name", "note"]);
  assert.deepEqual(merger.decodeMask(0b0010), ["name"]);

  const decoder = new UpdateMaskDecoder(schema);
  assert.deepEqual(decoder.decode("0x0a"), ["name", "note"]);
});

test("falls back to the before mask and then value diff", () => {
  const withBeforeMask = new CdcChangeMerger({ schema });
  withBeforeMask.ingest(beforeRow(10, 0b0010));
  assert.deepEqual(withBeforeMask.ingest(afterRow(10, 0)).updates[0].changedColumns, ["name"]);

  const noMask = new CdcChangeMerger({ schema });
  noMask.ingest(beforeRow(11, null));
  assert.deepEqual(noMask.ingest(afterRow(11, null)).updates[0].changedColumns, [
    "name",
    "note",
  ]);

  const emptyMask = new CdcChangeMerger({ schema });
  emptyMask.ingest(beforeRow(12, new Uint8Array(0)));
  assert.deepEqual(
    emptyMask.ingest(afterRow(12, new Uint8Array(0))).updates[0].changedColumns,
    ["name", "note"],
  );
});

test("does not publish a pending half again after the watermark passes", () => {
  const merger = new CdcChangeMerger({ schema });
  merger.ingest(afterRow(20));
  assert.equal(merger.pendingCount, 1);

  const gaps = merger.advanceWatermark(lsn(21));
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, "cleanup-watermark");
  assert.deepEqual(gaps[0].missing, ["before"]);
  assert.equal(gaps[0].lsnKey, "14");
  assert.equal(merger.pendingCount, 0);
  assert.equal(merger.gapCount, 1);

  const replay = merger.ingest(beforeRow(20));
  assert.equal(replay.changes.length, 0);
  assert.equal(replay.duplicates[0].reason, "gap");
  assert.equal(merger.pendingCount, 0);
});

test("reports the missing after image when only the before image was seen", () => {
  const merger = new CdcChangeMerger({ schema });
  merger.ingest(beforeRow(25));
  const gaps = merger.advanceWatermark(lsn(26));
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0].missing, ["after"]);
  assert.deepEqual(gaps[0].pending.missing, ["after"]);
});

test("watermark equality is retained unless inclusive mode is requested", () => {
  const strict = new CdcChangeMerger({ schema });
  strict.ingest(beforeRow(30));
  assert.equal(strict.advanceWatermark(lsn(30)).length, 0);
  assert.equal(strict.pendingCount, 1);

  const inclusive = new CdcChangeMerger({ schema, watermarkInclusive: true });
  inclusive.ingest(beforeRow(30));
  assert.equal(inclusive.advanceWatermark(lsn(30)).length, 1);
  assert.equal(inclusive.pendingCount, 0);
});

test("rows arriving already below a known watermark become gaps immediately", () => {
  const merger = new CdcChangeMerger({ schema });
  merger.advanceWatermark(lsn(35));

  const result = merger.ingest(afterRow(34));
  assert.equal(result.changes.length, 0);
  assert.equal(result.gaps.length, 1);
  assert.deepEqual(result.gaps[0].missing, ["before"]);
  assert.equal(merger.pendingCount, 0);
  assert.equal(merger.gapCount, 1);

  assert.equal(merger.ingest(beforeRow(34)).duplicates[0].reason, "gap");
});

test("restores permanent gaps and keeps suppressing replays", () => {
  const first = new CdcChangeMerger({ schema });
  first.ingest(afterRow(36));
  assert.equal(first.advanceWatermark(lsn(37)).length, 1);

  const second = new CdcChangeMerger({ schema, state: first.snapshot() });
  assert.equal(second.gapCount, 1);
  const replay = second.ingest(beforeRow(36));
  assert.equal(replay.gaps.length, 0);
  assert.equal(replay.duplicates[0].reason, "gap");
});

test("persists Date and BigInt values inside pending rows", () => {
  const typedSchema = {
    captureInstance: "dbo_Typed",
    columns: ["id", "createdAt", "amount"],
  };
  const first = new CdcChangeMerger({ schema: typedSchema });
  first.ingest({
    "__$start_lsn": lsn(38),
    "__$seqval": lsn(1),
    "__$operation": 3,
    "__$update_mask": 0,
    id: 1,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    amount: 12n,
  });
  const saved = first.saveState();

  const second = new CdcChangeMerger({ state: saved });
  const result = second.ingest({
    "__$start_lsn": lsn(38),
    "__$seqval": lsn(1),
    "__$operation": 4,
    "__$update_mask": 0b100,
    id: 1,
    createdAt: new Date("2026-01-02T03:04:06.000Z"),
    amount: 13n,
  });
  assert.equal(result.updates.length, 1);
  assert.ok(result.updates[0].beforeValues.createdAt instanceof Date);
  assert.equal(result.updates[0].beforeValues.amount, 12n);
  assert.deepEqual(result.updates[0].changedColumns, ["amount"]);
});

test("the higher of global and instance watermarks expires pending rows", () => {
  const merger = new CdcChangeMerger({ schema });
  merger.ingest(afterRow(37));
  assert.equal(merger.advanceWatermark(lsn(38), "dbo_Items").length, 1);

  const second = new CdcChangeMerger({ schema });
  second.ingest(afterRow(39));
  assert.equal(second.advanceWatermark(lsn(38), "dbo_Items").length, 0);
  assert.equal(second.advanceWatermark(lsn(40)).length, 1);
});

test("watermarks are monotonic and can be scoped per capture instance", () => {
  const other = {
    captureInstance: "dbo_Other",
    columns: ["id", "value"],
  };
  const merger = new CdcChangeMerger({ schemas: [schema, other] });
  merger.ingest({ ...afterRow(40), captureInstance: "dbo_Items" });
  merger.ingest({
    "__$start_lsn": lsn(40),
    "__$seqval": lsn(1),
    "__$operation": 3,
    id: 1,
    value: "old",
    captureInstance: "dbo_Other",
  });

  assert.equal(merger.advanceWatermark(lsn(50), "dbo_Items").length, 1);
  assert.equal(merger.pendingCount, 1);
  assert.equal(merger.advanceWatermark(lsn(50), "dbo_Other").length, 1);
  assert.equal(merger.pendingCount, 0);
  assert.equal(merger.advanceWatermark(lsn(45)).length, 0);
});

test("persists pending halves and resumes pairing after restart", () => {
  const first = new CdcChangeMerger({ schema });
  first.ingest(afterRow(60));
  const saved = JSON.parse(JSON.stringify(first.snapshot()));

  const second = new CdcChangeMerger({ schema, state: saved });
  assert.equal(second.pendingCount, 1);
  const result = second.ingest(beforeRow(60));
  assert.equal(result.updates.length, 1);
  assert.equal(result.pending.length, 0);
});

test("a snapshot is self-contained when restored without a schema option", () => {
  const first = new CdcChangeMerger({ schema });
  first.ingest(beforeRow(61));
  const second = new CdcChangeMerger({ state: first.snapshot() });
  const result = second.ingest(afterRow(61));
  assert.equal(result.updates.length, 1);
  assert.deepEqual(result.updates[0].changedColumns, ["name", "note"]);
});

test("restart never republishes an already paired update", () => {
  const first = new CdcChangeMerger({ schema });
  first.ingest(beforeRow(70));
  assert.equal(first.ingest(afterRow(70)).updates.length, 1);
  const saved = first.saveState();

  const second = new CdcChangeMerger({ schema, state: JSON.parse(saved) });
  const replayed = second.ingestMany([beforeRow(70), afterRow(70)]);
  assert.equal(replayed.changes.length, 0);
  assert.equal(replayed.pending.length, 0);
  assert.equal(replayed.duplicates.length, 2);
  assert.ok(replayed.duplicates.every((duplicate) => duplicate.reason === "published"));
  assert.equal(second.publishedCount, 1);
});

test("publishes single-row inserts and deletes only once", () => {
  const merger = new CdcChangeMerger({ schema });
  const insert: CdcChangeRow = {
    "__$start_lsn": lsn(80),
    "__$seqval": lsn(1),
    "__$operation": 2,
    "__$update_mask": "0x0f",
    id: 9,
    name: "inserted",
    qty: 1,
    note: null,
  };
  const del: CdcChangeRow = {
    "__$start_lsn": lsn(81),
    "__$seqval": lsn(1),
    "__$operation": 1,
    "__$update_mask": null,
    id: 9,
    name: "deleted",
    qty: 1,
    note: null,
  };
  const result = merger.ingestMany([del, insert]);
  assert.equal(result.inserts.length, 1);
  assert.equal(result.deletes.length, 1);
  assert.equal(result.changes[0].kind, "insert");
  assert.equal(result.changes[1].kind, "delete");
  assert.deepEqual(merger.ingest(insert).changes, []);
});

test("can suppress insert/delete publication while still deduplicating", () => {
  const merger = new CdcChangeMerger({ schema, includeSingleRowChanges: false });
  const insert: CdcChangeRow = {
    "__$start_lsn": lsn(82),
    "__$seqval": lsn(1),
    "__$operation": 2,
    id: 1,
  };
  assert.equal(merger.ingest(insert).changes.length, 0);
  assert.equal(merger.ingest(insert).duplicates[0].reason, "published");
});

test("handles duplicate pending images and conflicting images", () => {
  const merger = new CdcChangeMerger({ schema });
  merger.ingest(beforeRow(90));
  const duplicate = merger.ingest(beforeRow(90));
  assert.equal(duplicate.duplicates[0].reason, "pending");

  const conflict = merger.ingest({ ...beforeRow(90), name: "different" });
  assert.equal(conflict.duplicates[0].reason, "conflict");
  assert.equal(merger.pendingCount, 1);
  assert.equal(merger.ingest(afterRow(90)).updates.length, 1);
});

test("functional API returns published changes, pending rows, and gaps", () => {
  const paired = mergeCdcRows([beforeRow(100), afterRow(100)], schema);
  assert.equal(paired.updates.length, 1);
  assert.equal(paired.pending.length, 0);

  const gapped = mergeCdcRows([afterRow(101)], schema, { watermark: lsn(102) });
  assert.equal(gapped.gaps.length, 1);
  assert.equal(gapped.pending.length, 0);
  assert.deepEqual(gapped.gaps[0].missing, ["before"]);

  const gappedAlias = mergeCdcRows([afterRow(103)], schema, {
    cleanupWatermark: lsn(104),
  });
  assert.equal(gappedAlias.gaps.length, 1);
  assert.equal(gappedAlias.pending.length, 0);
});

test("multi-instance keys never collide on equal LSN and seqval", () => {
  const other = {
    captureInstance: "dbo_Other",
    columns: ["id", "amount"],
  };
  const rows: CdcChangeRow[] = [
    {
      "__$start_lsn": lsn(110),
      "__$seqval": lsn(1),
      "__$operation": 3,
      "__$update_mask": 0,
      captureInstance: "dbo_Items",
      id: 1,
      name: "old",
      qty: 0,
      note: null,
    },
    {
      "__$start_lsn": lsn(110),
      "__$seqval": lsn(1),
      "__$operation": 4,
      "__$update_mask": 0b0010,
      captureInstance: "dbo_Items",
      id: 1,
      name: "new",
      qty: 0,
      note: null,
    },
    {
      "__$start_lsn": lsn(110),
      "__$seqval": lsn(1),
      "__$operation": 3,
      "__$update_mask": 0,
      captureInstance: "dbo_Other",
      id: 2,
      amount: 1,
    },
    {
      "__$start_lsn": lsn(110),
      "__$seqval": lsn(1),
      "__$operation": 4,
      "__$update_mask": 0b10,
      captureInstance: "dbo_Other",
      id: 2,
      amount: 3,
    },
  ];
  const merger = new CdcChangeMerger({ schemas: [schema, other] });
  const multi = merger.ingestMany(rows);
  assert.equal(multi.updates.length, 2);
  assert.deepEqual(
    multi.updates.map((update) => update.captureInstance),
    ["dbo_Items", "dbo_Other"],
  );
});
