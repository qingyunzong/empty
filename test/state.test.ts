import assert from "node:assert/strict";
import test from "node:test";

import {
  ChangeStreamState,
  isHistoryLostError,
  resolveFullDocument,
} from "../index.ts";
import type { ChangeStreamEvent, Namespace } from "../index.ts";

const ns: Namespace = { db: "app", coll: "users" };

function event(
  token: unknown,
  operationType: string,
  extra: Partial<ChangeStreamEvent> = {},
): ChangeStreamEvent {
  return {
    _id: token,
    operationType,
    ns,
    documentKey: { _id: 1 },
    ...extra,
  };
}

test("token is exposed only after its batch is acknowledged", () => {
  const state = new ChangeStreamState();
  const [batch] = state.push(
    event({ t: 1 }, "insert", { fullDocument: { _id: 1, name: "a" } }),
  );

  assert.ok(batch);
  assert.equal(batch.token, batch.events[0].resumeToken);
  assert.equal(state.resumeToken, null);
  assert.equal(state.pendingBatchCount, 1);

  const result = state.acknowledge(batch);
  assert.equal(result.accepted, true);
  assert.equal(result.committed, true);
  assert.deepEqual(result.committedBatchIds, [batch.id]);
  assert.deepEqual(state.resumeToken, { t: 1 });
  assert.equal(state.pendingBatchCount, 0);
});

test("out-of-order acknowledgements commit only the contiguous prefix", () => {
  const state = new ChangeStreamState();
  const [first] = state.push(event({ t: 1 }, "insert"));
  const [second] = state.push(event({ t: 2 }, "insert"));

  const secondResult = state.acknowledge(second);
  assert.equal(secondResult.committed, false);
  assert.equal(state.resumeToken, null);

  const firstResult = state.acknowledge(first);
  assert.equal(firstResult.committed, true);
  assert.deepEqual(firstResult.committedBatchIds, [first.id, second.id]);
  assert.deepEqual(state.resumeToken, { t: 2 });
});

test("direct token commit cannot bypass batch acknowledgement", () => {
  const state = new ChangeStreamState();
  const [batch] = state.push(event({ t: 1 }, "insert"));

  const pending = state.commitToken({ t: 1 });
  assert.equal(pending.accepted, false);
  assert.equal(pending.reason, "batch-not-acknowledged");
  assert.equal(state.resumeToken, null);

  state.acknowledge(batch);
  const committed = state.commitToken({ t: 1 });
  assert.equal(committed.accepted, true);
  assert.deepEqual(state.resumeToken, { t: 1 });
});

test("a rejected batch blocks later token commits", () => {
  const state = new ChangeStreamState();
  const [first] = state.push(event({ t: 1 }, "insert"));
  const [second] = state.push(event({ t: 2 }, "insert"));

  assert.equal(state.reject(first), true);
  const result = state.acknowledge(second);
  assert.equal(result.committed, false);
  assert.equal(state.resumeToken, null);
});

test("transaction events are emitted atomically in one batch", () => {
  const state = new ChangeStreamState();
  const lsid = { id: "session-1" };

  assert.deepEqual(
    state.push(event({ t: 1 }, "insert", { lsid, txnNumber: 7 })),
    [],
  );
  assert.deepEqual(
    state.push(event({ t: 2 }, "update", { lsid, txnNumber: 7 })),
    [],
  );
  assert.equal(state.hasOpenTransactions, true);

  const batches = state.flush();
  assert.equal(batches.length, 1);
  const [batch] = batches;
  assert.equal(batch.kind, "transaction");
  assert.equal(batch.events.length, 2);
  assert.equal(batch.events[0].transaction?.sequence, 1);
  assert.equal(batch.events[0].transaction?.eventCount, 2);
  assert.equal(batch.events[1].transaction?.sequence, 2);
  assert.deepEqual(batch.token, { t: 2 });
  assert.equal(state.resumeToken, null);

  state.acknowledge(batch.id);
  assert.deepEqual(state.resumeToken, { t: 2 });
});

test("a non-transaction boundary flushes an open transaction", () => {
  const state = new ChangeStreamState();
  const lsid = "session-2";
  state.push(event({ t: 1 }, "insert", { lsid, txnNumber: 1 }));

  const output = state.push(event({ t: 2 }, "delete"));
  assert.equal(output.length, 2);
  assert.equal(output[0].kind, "transaction");
  assert.equal(output[1].kind, "events");
  assert.equal(state.openTransactionKeys.length, 0);
});

test("invalidate starts a new snapshot generation and abandons old batches", () => {
  const state = new ChangeStreamState({
    resumeToken: { seed: true },
  });
  const [pending] = state.push(event({ t: 1 }, "insert"));
  assert.equal(pending.status, "pending");
  assert.deepEqual(state.resumeToken, { seed: true });

  const [control] = state.push(event({ t: 2 }, "invalidate"));
  assert.equal(control.kind, "control");
  assert.equal(control.token, null);
  assert.equal(control.control?.type, "invalidate");
  assert.equal(control.control?.previousGeneration, 1);
  assert.equal(control.control?.nextGeneration, 2);

  assert.equal(state.generation, 2);
  assert.equal(state.status, "snapshot-required");
  assert.equal(state.resumeToken, null);
  assert.deepEqual(state.previousResumeToken, { seed: true });
  assert.equal(state.invalidated, true);

  assert.equal(pending.status, "abandoned");
  const staleAck = state.acknowledge(pending.id);
  assert.equal(staleAck.accepted, false);
  assert.equal(staleAck.reason, "stale-generation");
  assert.equal(state.resumeToken, null);

  const snapshot = state.completeSnapshot({ resumeToken: { snapshot: 1 } });
  assert.equal(snapshot.status, "live");
  assert.deepEqual(state.resumeToken, { snapshot: 1 });

  const [fresh] = state.push(event({ t: 3 }, "insert"));
  assert.deepEqual(state.resumeToken, { snapshot: 1 });
  state.acknowledge(fresh.id);
  assert.deepEqual(state.resumeToken, { t: 3 });
});

test("history lost starts a new generation without reusing the old cursor", () => {
  const state = new ChangeStreamState({ resumeToken: { old: 1 } });
  assert.equal(isHistoryLostError({ code: 286 }), true);
  assert.equal(
    isHistoryLostError({ name: "MongoServerError", message: "change stream history lost" }),
    true,
  );

  const transition = state.handleError({ code: 286, message: "history lost" });
  assert.ok(transition);
  assert.equal(transition.reason, "history-lost");
  assert.equal(state.generation, 2);
  assert.equal(state.status, "snapshot-required");
  assert.equal(state.resumeToken, null);
  assert.deepEqual(state.previousResumeToken, { old: 1 });
  assert.deepEqual(state.lastEverCommittedToken, { old: 1 });
  assert.equal(state.handleError(new Error("unrelated")), null);
});

test("rename updates the effective namespace and follows later events", () => {
  const state = new ChangeStreamState();
  const [renameBatch] = state.push({
    _id: { t: 1 },
    operationType: "rename",
    ns: { db: "app", coll: "users" },
    to: { db: "app", coll: "accounts" },
    documentKey: { _id: 1 },
  });

  assert.equal(renameBatch.events[0].renamed, true);
  assert.deepEqual(renameBatch.events[0].previousNamespace, {
    db: "app",
    coll: "users",
  });
  assert.deepEqual(renameBatch.events[0].namespace, {
    db: "app",
    coll: "accounts",
  });

  const [insertBatch] = state.push({
    _id: { t: 2 },
    operationType: "insert",
    ns: { db: "app", coll: "users" },
    documentKey: { _id: 2 },
  });
  assert.deepEqual(insertBatch.events[0].namespace, {
    db: "app",
    coll: "accounts",
  });
  assert.deepEqual(insertBatch.events[0].previousNamespace, {
    db: "app",
    coll: "users",
  });

  state.applyRename({ db: "app", coll: "accounts" }, {
    db: "app",
    coll: "people",
  });
  assert.deepEqual(state.namespaceFor({ db: "app", coll: "users" }), {
    db: "app",
    coll: "people",
  });

  state.acknowledge(renameBatch.id);
  state.acknowledge(insertBatch.id);
  assert.deepEqual(state.resumeToken, { t: 2 });
});

test("lookup preserves event-time and read-time evidence when it sees a newer version", async () => {
  const state = new ChangeStreamState();
  const eventTime = { t: 1_700_000_000, i: 4 };
  const readTime = new Date("2026-01-02T03:04:05.000Z");
  const change = event({ t: 9 }, "update", {
    clusterTime: eventTime,
    wallTime: new Date("2026-01-02T03:04:00.000Z"),
    fullDocument: { _id: 1, version: 1, name: "event-time" },
  });

  const evidence = await state.resolveFullDocument(
    change,
    async () => ({ _id: 1, version: 2, name: "read-time" }),
    { readTime },
  );

  assert.equal(evidence.newerThanEvent, true);
  assert.equal(evidence.lookupNewer, true);
  assert.equal(evidence.source, "lookup");
  assert.equal(evidence.versionComparison, "newer");
  assert.deepEqual(evidence.document, {
    _id: 1,
    version: 2,
    name: "read-time",
  });
  assert.deepEqual(evidence.eventTime, eventTime);
  assert.deepEqual(evidence.readTime, readTime);
  assert.deepEqual(evidence.preserved.event.document, {
    _id: 1,
    version: 1,
    name: "event-time",
  });
  assert.deepEqual(evidence.preserved.read.document, {
    _id: 1,
    version: 2,
    name: "read-time",
  });
  assert.deepEqual(evidence.preserved.read.time, readTime);

  const batches = await state.pushWithLookup(
    change,
    async () => ({ _id: 1, version: 2, name: "read-time" }),
    { readTime },
  );
  assert.equal(batches.length, 1);
  const output = batches[0].events[0];
  assert.deepEqual(output.fullDocument, {
    _id: 1,
    version: 2,
    name: "read-time",
  });
  assert.deepEqual(output.eventTime, eventTime);
  assert.deepEqual(output.readTime, readTime);
  assert.ok(output.fullDocumentLookup);
  assert.deepEqual(output.fullDocumentLookup?.eventDocument, {
    _id: 1,
    version: 1,
    name: "event-time",
  });
});

test("lookup does not replace an event document with an older version", async () => {
  const eventTime = { t: 1_700_000_100, i: 0 };
  const evidence = await resolveFullDocument(
    event({ t: 1 }, "update", {
      clusterTime: eventTime,
      fullDocument: { _id: 1, version: 8, name: "event-time" },
    }),
    { _id: 1, version: 7, name: "read-time" },
    { readTime: new Date("2026-01-02T03:04:05.000Z") },
  );

  assert.equal(evidence.newerThanEvent, false);
  assert.equal(evidence.versionComparison, "older");
  assert.equal(evidence.source, "event");
  assert.deepEqual(evidence.document, {
    _id: 1,
    version: 8,
    name: "event-time",
  });
  assert.deepEqual(evidence.readDocument, {
    _id: 1,
    version: 7,
    name: "read-time",
  });
});

test("a findOne lookup source receives the document key", async () => {
  let seenFilter: unknown = null;
  const evidence = await resolveFullDocument(
    event({ t: 1 }, "update", { documentKey: { _id: "abc" } }),
    {
      async findOne(filter) {
        seenFilter = filter;
        return { _id: "abc", version: 2 };
      },
    },
    { readTime: new Date("2026-01-02T03:04:05.000Z") },
  );

  assert.deepEqual(seenFilter, { _id: "abc" });
  assert.equal(evidence.source, "lookup");
  assert.equal(evidence.document?._id, "abc");
});

test("snapshot completion installs a fresh token only for the new generation", () => {
  const state = new ChangeStreamState();
  state.push(event({ t: 1 }, "insert"));
  state.historyLost(new Error("history lost"));
  assert.equal(state.snapshotRequired, true);

  const begun = state.beginSnapshot({ startAt: new Date("2026-01-01T00:00:00Z") });
  assert.equal(begun.status, "snapshotting");
  assert.equal(state.resumeToken, null);

  const completed = state.completeSnapshot({
    resumeToken: { snapshot: "v2" },
    readTime: new Date("2026-01-01T00:01:00Z"),
  });
  assert.equal(completed.status, "live");
  assert.deepEqual(state.resumeToken, { snapshot: "v2" });
  assert.equal(state.snapshotRequired, false);
  assert.equal(state.isHistoryLost, false);
  assert.equal(state.historyLostGeneration, true);
});
