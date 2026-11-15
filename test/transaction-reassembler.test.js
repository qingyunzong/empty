import assert from "node:assert/strict";
import test from "node:test";

import {
  DuplicateEventConflictError,
  TransactionReassembler,
  reassembleTransactions,
} from "../index.js";

function dataEvent(transactionId, totalOrder, dataCollectionOrder, collection, partition, offset) {
  return {
    topic: collection,
    partition,
    offset,
    transaction: {
      id: transactionId,
      total_order: totalOrder,
      data_collection_order: dataCollectionOrder,
    },
    value: {
      op: "c",
      after: { collection, totalOrder },
      source: { topic: collection, table: collection.split(".").at(-1) },
    },
  };
}

function begin(transactionId) {
  return { status: "BEGIN", id: transactionId };
}

function end(transactionId, eventCount, collections) {
  return {
    status: "END",
    id: transactionId,
    event_count: eventCount,
    data_collections: collections.map(([data_collection, event_count]) => ({
      data_collection,
      event_count,
    })),
  };
}

test("commits a complete cross-topic, cross-partition transaction in total_order order", () => {
  const reassembler = new TransactionReassembler({ now: () => 1_000 });

  assert.equal(reassembler.ingest(begin("tx-1")).length, 0);
  assert.equal(
    reassembler.ingest(dataEvent("tx-1", 3, 2, "schema.orders", 2, 30)).length,
    0,
  );
  assert.equal(
    reassembler.ingest(dataEvent("tx-1", 1, 1, "schema.customers", 0, 10)).length,
    0,
  );
  assert.equal(
    reassembler.ingest(dataEvent("tx-1", 2, 2, "schema.customers", 0, 11)).length,
    0,
  );

  const batches = reassembler.ingest(
    end("tx-1", 3, [
      ["schema.customers", 2],
      ["schema.orders", 1],
    ]),
  );

  assert.equal(batches.length, 1);
  assert.equal(batches[0].transactionId, "tx-1");
  assert.deepEqual(
    batches[0].events.map((event) => event.transaction.total_order),
    [1, 2, 3],
  );
  assert.deepEqual(
    batches[0].events.map((event) => event.partition),
    [0, 0, 2],
  );
  assert.equal(batches[0].complete, true);
  assert.equal(batches[0].transactional, true);
});

test("does not commit while a total_order is missing, then commits when it arrives", () => {
  const reassembler = new TransactionReassembler({ now: () => 1_000 });

  reassembler.ingest(dataEvent("tx-gap", 1, 1, "schema.t", 0, 1));
  reassembler.ingest(dataEvent("tx-gap", 3, 3, "schema.t", 0, 3));
  assert.equal(
    reassembler.ingest(end("tx-gap", 3, [["schema.t", 3]])).length,
    0,
  );

  const gap = reassembler.reportGaps()[0];
  assert.equal(gap.transactionId, "tx-gap");
  assert.deepEqual(gap.missingTotalOrders, [2]);
  assert.equal(reassembler.pendingCount, 1);

  const batches = reassembler.ingest(
    dataEvent("tx-gap", 2, 2, "schema.t", 0, 2),
  );
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0].events.map((event) => event.transaction.total_order),
    [1, 2, 3],
  );
});

test("deduplicates equal events and rejects conflicting duplicates", () => {
  const reassembler = new TransactionReassembler({ now: () => 1_000 });
  const first = dataEvent("tx-dup", 1, 1, "schema.t", 0, 1);

  reassembler.ingest(first);
  assert.equal(reassembler.ingest(structuredClone(first)).length, 0);
  const redelivered = { ...structuredClone(first), offset: 999 };
  assert.equal(reassembler.ingest(redelivered).length, 0);
  assert.equal(
    reassembler.ingest(end("tx-dup", 1, [["schema.t", 1]])).length,
    1,
  );
  const lateConflict = structuredClone(first);
  lateConflict.value.after.totalOrder = 42;
  assert.throws(
    () => reassembler.ingest(lateConflict),
    DuplicateEventConflictError,
  );

  const conflicted = new TransactionReassembler({ now: () => 1_000 });
  const original = dataEvent("tx-conflict", 1, 1, "schema.t", 0, 1);
  conflicted.ingest(original);
  const changed = structuredClone(original);
  changed.value.after.totalOrder = 99;
  assert.throws(
    () => conflicted.ingest(changed),
    (error) =>
      error instanceof DuplicateEventConflictError &&
      error.transactionId === "tx-conflict" &&
      error.totalOrder === 1,
  );

  assert.equal(
    conflicted.ingest(end("tx-conflict", 1, [["schema.t", 1]])).length,
    0,
  );
  assert.equal(conflicted.pendingCount, 1);
  assert.equal(conflicted.reportGaps()[0].conflict, true);
});

test("non-transactional events advance independently", () => {
  const reassembler = new TransactionReassembler({ now: () => 1_000 });
  reassembler.ingest(begin("tx-open"));
  reassembler.ingest(dataEvent("tx-open", 1, 1, "schema.t", 0, 1));

  const batches = reassembler.ingest({
    topic: "schema.audit",
    partition: 7,
    offset: 99,
    value: { op: "c", after: { id: 1 } },
  });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].transactional, false);
  assert.equal(batches[0].transactionId, null);
  assert.equal(batches[0].events[0].topic, "schema.audit");

  assert.equal(
    reassembler.ingest(end("tx-open", 1, [["schema.t", 1]])).length,
    1,
  );
});

test("timeout reports gaps only and never emits a partial transaction", () => {
  let now = 1_000;
  const reassembler = new TransactionReassembler({ now: () => now, timeoutMs: 500 });

  reassembler.ingest(begin("tx-slow"));
  reassembler.ingest(dataEvent("tx-slow", 1, 1, "schema.t", 0, 1));
  reassembler.ingest(dataEvent("tx-slow", 3, 3, "schema.t", 0, 3));
  reassembler.ingest(end("tx-slow", 3, [["schema.t", 3]]));

  now = 2_000;
  const gaps = reassembler.checkTimeouts();
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, "timeout");
  assert.equal(gaps[0].timedOut, true);
  assert.deepEqual(gaps[0].missingTotalOrders, [2]);
  assert.equal(reassembler.pendingCount, 1);
  assert.equal(reassembler.deliveredCount, 0);

  now = 3_000;
  const batches = reassembler.ingest(dataEvent("tx-slow", 2, 2, "schema.t", 0, 2));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].events.length, 3);
});

test("restores incomplete state without publishing and finishes it later", () => {
  const first = new TransactionReassembler({ now: () => 1_000 });
  first.ingest(begin("tx-recover"));
  first.ingest(dataEvent("tx-recover", 1, 1, "schema.a", 0, 1));
  first.ingest(dataEvent("tx-recover", 3, 3, "schema.a", 0, 3));
  first.ingest(end("tx-recover", 3, [["schema.a", 3]]));

  const snapshot = first.serialize();
  const recovered = new TransactionReassembler({ now: () => 2_000 });
  assert.deepEqual(recovered.restore(snapshot), []);
  assert.equal(recovered.pendingCount, 1);
  assert.deepEqual(recovered.reportGaps()[0].missingTotalOrders, [2]);

  const batches = recovered.ingest(dataEvent("tx-recover", 2, 2, "schema.a", 0, 2));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].events.length, 3);
});

test("recovery publishes only complete transactions from a completed snapshot", () => {
  const first = new TransactionReassembler({
    now: () => 1_000,
    autoCommit: false,
  });
  first.ingest(dataEvent("tx-complete", 1, 1, "schema.a", 0, 1));
  first.ingest(end("tx-complete", 1, [["schema.a", 1]]));
  first.ingest(dataEvent("tx-incomplete", 1, 1, "schema.b", 0, 2));
  first.ingest(end("tx-incomplete", 2, [["schema.b", 2]]));

  assert.equal(first.pendingCount, 2);

  const recovered = new TransactionReassembler({ now: () => 2_000 });
  const batches = recovered.restore(first.snapshot());
  assert.equal(batches.length, 1);
  assert.equal(batches[0].transactionId, "tx-complete");
  assert.equal(recovered.pendingCount, 1);
  assert.equal(recovered.reportGaps()[0].transactionId, "tx-incomplete");
});

test("data_collection_order gaps block the transaction", () => {
  const reassembler = new TransactionReassembler({ now: () => 1_000 });
  reassembler.ingest(dataEvent("tx-collection", 1, 1, "schema.a", 0, 1));
  reassembler.ingest(dataEvent("tx-collection", 2, 3, "schema.a", 0, 3));
  assert.equal(
    reassembler.ingest(end("tx-collection", 2, [["schema.a", 2]])).length,
    0,
  );
  const gap = reassembler.reportGaps()[0];
  assert.deepEqual(gap.missingDataCollectionOrders["schema.a"], [2]);
});

test("abort discards buffered events and prevents a later commit", () => {
  const reassembler = new TransactionReassembler({ now: () => 1_000 });
  reassembler.ingest(dataEvent("tx-abort", 1, 1, "schema.a", 0, 1));
  reassembler.ingest({ status: "ABORT", id: "tx-abort" });
  assert.equal(reassembler.pendingCount, 0);
  assert.equal(
    reassembler.ingest(end("tx-abort", 1, [["schema.a", 1]])).length,
    0,
  );
});

test("callback and autoCommit=false drain complete batches", () => {
  const committed = [];
  const reassembler = new TransactionReassembler({
    now: () => 1_000,
    autoCommit: false,
    onCommit: (batch) => committed.push(batch.transactionId),
  });
  reassembler.ingest(dataEvent("tx-later", 1, 1, "schema.a", 0, 1));
  assert.equal(
    reassembler.ingest(end("tx-later", 1, [["schema.a", 1]])).length,
    0,
  );
  assert.deepEqual(committed, []);
  const flushed = reassembler.flush();
  assert.equal(flushed.length, 1);
  assert.deepEqual(committed, ["tx-later"]);
});

test("functional helper returns only complete transactions", () => {
  const batches = reassembleTransactions(
    [
      begin("tx-a"),
      dataEvent("tx-a", 1, 1, "schema.a", 0, 1),
      end("tx-a", 1, [["schema.a", 1]]),
      begin("tx-b"),
      dataEvent("tx-b", 1, 1, "schema.b", 0, 2),
    ],
    { now: () => 1_000 },
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0].transactionId, "tx-a");
  assert.equal(batches.gaps.length, 1);
  assert.equal(batches.gaps[0].transactionId, "tx-b");
});

test("accepts schema-envelope payloads, keyed metadata, and zero-based ordinals", () => {
  const reassembler = new TransactionReassembler({ now: () => 1_000 });
  const payloadEvent = {
    topic: "server.schema.customers",
    transaction: { id: "tx-payload", total_order: 0, data_collection_order: 0 },
    value: {
      payload: {
        op: "c",
        after: { id: 1 },
        source: { topic: "server.schema.customers", table: "customers" },
      },
    },
  };
  assert.equal(reassembler.ingest(payloadEvent).length, 0);
  const batches = reassembler.ingest({
    topic: "server.transaction",
    key: { id: "tx-payload" },
    value: { status: "END", event_count: 1 },
  });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].events[0], payloadEvent);
});

test("supports composite dataEvent/transactionMetadata records", () => {
  const reassembler = new TransactionReassembler({ now: () => 1_000 });
  const data = dataEvent("tx-composite", 1, 1, "schema.a", 0, 1);
  const batches = reassembler.ingest({
    dataEvent: data,
    transactionMetadata: end("tx-composite", 1, [["schema.a", 1]]),
  });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].transactionId, "tx-composite");
});

test("does not republish an already delivered transaction after snapshot recovery", () => {
  const reassembler = new TransactionReassembler({ now: () => 1_000 });
  reassembler.ingest(dataEvent("tx-published", 1, 1, "schema.a", 0, 1));
  assert.equal(
    reassembler.ingest(end("tx-published", 1, [["schema.a", 1]])).length,
    1,
  );

  const recovered = new TransactionReassembler({ now: () => 2_000 });
  assert.deepEqual(recovered.restore(reassembler.snapshot()), []);
  assert.equal(
    recovered.ingest(dataEvent("tx-published", 1, 1, "schema.a", 0, 1)).length,
    0,
  );
  assert.equal(
    recovered.ingest(end("tx-published", 1, [["schema.a", 1]])).length,
    0,
  );
});
