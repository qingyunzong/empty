import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DuplicateClientItemIdError,
  SubRequestBatchState,
  buildRetryBatch,
  reconcileBatchResponse,
  splitBatchResponse,
  type BatchResultItem,
  type SubRequest,
} from "../index.js";

function requests(count: number): SubRequest<unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    clientItemId: `item-${index + 1}`,
    idempotencyKey: `idem-${index + 1}`,
    payload: { row: index + 1 },
  }));
}

test("pairs out-of-order results by exact clientItemId and splits all states", () => {
  const result = reconcileBatchResponse(requests(5), [
    { clientItemId: "item-4", status: "success", value: { row: 4 } },
    { clientItemId: "item-2", status: "retryable", error: { code: "BUSY" } },
    {
      clientItemId: "item-3",
      status: "permanent_failure",
      error: { code: "INVALID" },
    },
    { clientItemId: "item-5", status: "success", result: { row: 5 } },
  ]);

  assert.deepEqual(result.success.map((record) => record.clientItemId), [
    "item-4",
    "item-5",
  ]);
  assert.deepEqual(result.retryable.map((record) => record.clientItemId), [
    "item-2",
  ]);
  assert.deepEqual(result.failed.map((record) => record.clientItemId), [
    "item-3",
  ]);
  assert.deepEqual(result.missing.map((record) => record.clientItemId), [
    "item-1",
  ]);
  assert.equal(result.items[0]?.state, "missing");
  assert.equal(result.items[3]?.state, "success");
});

test("does not positionally pair unknown or differently-cased ids", () => {
  const result = reconcileBatchResponse(requests(2), [
    { clientItemId: "ITEM-1", status: "success", value: 1 },
    { clientItemId: " item-2 ", status: "success", value: 2 },
    { clientItemId: "item-9", status: "success", value: 9 },
  ]);

  assert.equal(result.success.length, 0);
  assert.equal(result.missing.length, 2);
  assert.equal(result.unknownResults.length, 3);
  assert.deepEqual(result.retryBatch.map((item) => item.clientItemId), []);
  assert.deepEqual(
    result.tracker.getRetryBatch({ includeUnresolved: true }).map(
      (item) => item.clientItemId,
    ),
    [
      "item-1",
      "item-2",
    ],
  );
});

test("deduplicates identical duplicates and quarantines conflicting duplicates", () => {
  const identical = reconcileBatchResponse(requests(1), [
    {
      clientItemId: "item-1",
      status: "success",
      value: { nested: { b: 2, a: 1 } },
    },
    {
      clientItemId: "item-1",
      status: "succeeded",
      result: { nested: { a: 1, b: 2 } },
    },
  ]);
  assert.equal(identical.success.length, 1);
  assert.equal(identical.success[0]?.duplicateCount, 1);
  assert.equal(identical.quarantined.length, 0);

  const conflict = reconcileBatchResponse(requests(1), [
    { clientItemId: "item-1", status: "success", value: 1 },
    { clientItemId: "item-1", status: "success", value: 2 },
  ]);
  assert.equal(conflict.success.length, 0);
  assert.equal(conflict.quarantined.length, 1);
  assert.equal(
    conflict.quarantined[0]?.quarantine?.reason,
    "conflicting-duplicates",
  );
  assert.equal(conflict.quarantined[0]?.quarantine?.observations.length, 2);
  assert.equal(conflict.retryBatch.length, 0);
});

test("quarantines results whose idempotency key does not match", () => {
  const result = reconcileBatchResponse(requests(1), [
    {
      clientItemId: "item-1",
      status: "success",
      value: { row: 1 },
      idempotencyKey: "stale-key",
    },
  ]);

  assert.equal(result.success.length, 0);
  assert.equal(result.quarantined.length, 1);
  assert.equal(
    result.quarantined[0]?.quarantine?.reason,
    "idempotency-key-mismatch",
  );
});

test("retry batch contains only retryable and missing requests with original keys", () => {
  const source = requests(5);
  const state = new SubRequestBatchState(source);
  state.applyResponse([
    { clientItemId: "item-1", status: "success", value: { row: 1 } },
    { clientItemId: "item-2", status: "retryable", error: { code: "BUSY" } },
    { clientItemId: "item-3", status: "failed", error: { code: "BAD" } },
    { clientItemId: "item-5", status: "retryable", error: { code: "BUSY" } },
  ]);

  const retry = state.getRetryBatch();
  assert.deepEqual(
    retry.map((item) => item.clientItemId),
    ["item-2", "item-5"],
  );
  assert.deepEqual(retry.reasons, {
    "item-2": "retryable",
    "item-5": "retryable",
  });
  for (const item of retry) {
    const original = source.find(
      (request) => request.clientItemId === item.clientItemId,
    );
    assert.equal(item.idempotencyKey, original?.idempotencyKey);
  }
  assert.equal(retry.items, retry);
  assert.deepEqual(retry.clientItemIds, ["item-2", "item-5"]);

  assert.deepEqual(
    state.getRetryBatch({ includeMissing: true }).map((item) => item.clientItemId),
    ["item-2", "item-4", "item-5"],
  );
  assert.deepEqual(
    state.getRetryBatch({ includeUnresolved: true }).map(
      (item) => item.clientItemId,
    ),
    ["item-2", "item-4", "item-5"],
  );
  assert.deepEqual(
    state.getRetryBatch({ includeMissing: false }).map((item) => item.clientItemId),
    ["item-2", "item-5"],
  );
  assert.deepEqual(
    buildRetryBatch(state).map((item) => item.clientItemId),
    ["item-2", "item-5"],
  );
});

test("batch timeout only retries unresolved work and keeps confirmed success", () => {
  const source = requests(4);
  const state = new SubRequestBatchState(source, { finalizeMissing: false });
  state.applyResponse([
    { clientItemId: "item-1", status: "success", value: { row: 1 } },
    {
      clientItemId: "item-2",
      status: "permanent_failure",
      error: { code: "BAD" },
    },
  ]);
  state.markTimedOut();

  const snapshot = state.snapshot();
  assert.equal(snapshot.success.length, 1);
  assert.equal(snapshot.success[0]?.clientItemId, "item-1");
  assert.equal(snapshot.failed.length, 1);
  assert.deepEqual(snapshot.retryable.map((record) => record.clientItemId), [
    "item-3",
    "item-4",
  ]);
  assert.deepEqual(snapshot.retryBatch.map((item) => item.clientItemId), [
    "item-3",
    "item-4",
  ]);
  assert.deepEqual(snapshot.retryBatch.reasons, {
    "item-3": "timeout",
    "item-4": "timeout",
  });
  assert.equal(snapshot.retryBatch[0]?.idempotencyKey, "idem-3");

  state.markTimedOut();
  assert.equal(state.snapshot().success.length, 1);
});

test("timeout in the response envelope preserves successes returned in that batch", () => {
  const result = reconcileBatchResponse(
    requests(3),
    {
      timedOut: true,
      results: [
        { clientItemId: "item-2", status: "success", value: { row: 2 } },
      ],
    },
  );

  assert.deepEqual(result.success.map((record) => record.clientItemId), [
    "item-2",
  ]);
  assert.deepEqual(result.retryable.map((record) => record.clientItemId), [
    "item-1",
    "item-3",
  ]);
  assert.equal(result.missing.length, 0);
});

test("a late result after a timeout replaces the provisional retryable state", () => {
  const state = new SubRequestBatchState(requests(2));
  state.markTimedOut();
  assert.equal(state.getState("item-1"), "retryable");

  state.applyResponse([
    { clientItemId: "item-1", status: "success", value: { row: 1 } },
    { clientItemId: "item-2", status: "missing" },
  ]);
  assert.equal(state.getState("item-1"), "success");
  assert.equal(state.getState("item-2"), "retryable");
});

test("a late success upgrades a missing item without a conflict", () => {
  const state = new SubRequestBatchState(requests(1));
  state.applyResponse([]);
  assert.equal(state.getState("item-1"), "missing");

  state.applyResponse([
    { clientItemId: "item-1", status: "success", value: { row: 1 } },
  ]);
  assert.equal(state.getState("item-1"), "success");
  assert.equal(state.snapshot().quarantined.length, 0);
});

test("accepts ok/retryable shorthands and explicit missing entries", () => {
  const result = reconcileBatchResponse(requests(3), [
    { clientItemId: "item-1", ok: true, value: 1 },
    { clientItemId: "item-2", ok: false, retryable: true },
    { clientItemId: "item-3", status: "missing" },
  ] as BatchResultItem<unknown>[]);

  assert.equal(result.success.length, 1);
  assert.equal(result.retryable.length, 1);
  assert.equal(result.missing.length, 1);
  assert.equal(result.items[2]?.reason, "missing-in-response");
});

test("accepts keyed result collections and value-only successes", () => {
  const keyed = reconcileBatchResponse(requests(2), {
    results: {
      "item-2": { status: "success", value: { row: 2 } },
      "item-1": { ok: false, retryable: true },
    },
  });
  assert.deepEqual(keyed.success.map((record) => record.clientItemId), [
    "item-2",
  ]);
  assert.deepEqual(keyed.retryable.map((record) => record.clientItemId), [
    "item-1",
  ]);

  const inferred = reconcileBatchResponse(requests(1), {
    results: new Map([
      ["item-1", { value: { row: 1 } }],
    ]),
  });
  assert.equal(inferred.success.length, 1);
  assert.deepEqual(inferred.success[0]?.value, { row: 1 });
});

test("rejects duplicate request ids before applying a response", () => {
  assert.throws(
    () =>
      new SubRequestBatchState([
        { clientItemId: "same", idempotencyKey: "one" },
        { clientItemId: "same", idempotencyKey: "two" },
      ]),
    DuplicateClientItemIdError,
  );
});

test("splitBatchResponse alias exposes the same grouping", () => {
  const result = splitBatchResponse(requests(3), [
    { clientItemId: "item-1", status: "success", value: 1 },
    { clientItemId: "item-2", status: "retryable" },
  ]);

  assert.equal(result.counts.success, 1);
  assert.equal(result.counts.retryable, 1);
  assert.equal(result.counts.missing, 1);
  assert.deepEqual(result.toRetry, result.retryBatch);
  assert.deepEqual(result.retryBatch.map((item) => item.clientItemId), [
    "item-2",
  ]);
  assert.deepEqual(
    result.tracker.getRetryBatch({ includeUnresolved: true }).map(
      (item) => item.clientItemId,
    ),
    ["item-2", "item-3"],
  );
});
