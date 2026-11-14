// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectionState,
  EventConflictError,
  WatermarkTracker,
  createConnectionState,
} from "../index.ts";

function clock() {
  let value = 1_000;
  return {
    now: () => value,
    tick: (ms = 1) => {
      value += ms;
      return value;
    },
    set: (next: number) => {
      value = next;
      return value;
    },
  };
}

test("coordinates connection_ack, subscription id, and pre-ack events", () => {
  const state = new ConnectionState();
  assert.equal(state.handleConnectionAck().status, "acknowledged");

  const subscribed = state.subscribe("sub-1");
  assert.equal(subscribed.status, "subscribed");
  assert.deepEqual(subscribed.message, { type: "subscribe", id: "sub-1" });

  assert.equal(
    state.handleNext({ version: 1, data: { value: 1 } }, "other").status,
    "ignored",
  );
  assert.equal(state.handleNext({ version: 1, data: { value: 1 } }).status, "accepted");

  const fresh = createConnectionState();
  assert.equal(fresh.subscribe("sub-a").status, "pending-ack");
  assert.equal(
    fresh.handleNext({ version: 1, data: { value: 1 } }, "sub-a").status,
    "ignored",
  );
  assert.equal(fresh.handleConnectionAck().status, "acknowledged");
  assert.equal(fresh.subscribed, true);
  assert.equal(
    fresh.handleNext({ version: 1, data: { value: 1 } }, "sub-a").status,
    "accepted",
  );
});

test("dedupes identical content and reports same-version conflicts", () => {
  const state = createConnectionState();
  state.handleConnectionAck();
  state.subscribe("sub-1");

  const first = state.handleNext({ version: 7, data: { rows: [1, 2] } });
  assert.equal(first.status, "accepted");
  assert.equal(first.watermark, 0);

  const duplicate = state.handleNext({ version: 7, data: { rows: [1, 2] } });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(duplicate.conflict, false);

  const conflict = state.handleNext({ version: 7, data: { rows: [1, 3] } });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.conflict, true);
  assert.deepEqual(conflict.existingContent, { data: { rows: [1, 2] } });
  assert.equal(state.conflictCount, 1);

  assert.equal(state.dedupeRecords.length, 2);
  assert.deepEqual(
    state.dedupeRecords.map((record) => record.reason),
    ["duplicate", "conflict"],
  );
  const [duplicateRecord, conflictRecord] = state.dedupeRecords;
  assert.equal(duplicateRecord.version, 7);
  assert.equal(conflictRecord.version, 7);
  assert.notEqual(
    duplicateRecord.incomingContentHash,
    conflictRecord.incomingContentHash,
  );
  assert.equal(conflictRecord.existingContentHash, duplicateRecord.incomingContentHash);
});

test("advances the watermark only after downstream acknowledgement", () => {
  const state = createConnectionState();
  state.handleConnectionAck();
  state.subscribe("sub-1");

  state.handleNext({ version: 1, data: { value: "one" } });
  state.handleNext({ version: 2, data: { value: "two" } });
  assert.equal(state.watermark, 0);
  assert.deepEqual(state.pendingVersions, [1, 2]);

  const ackTwo = state.ack(2);
  assert.equal(ackTwo.status, "acknowledged");
  assert.equal(ackTwo.advanced, false);
  assert.equal(state.watermark, 0);

  const ackOne = state.acknowledge({ version: 1 });
  assert.equal(ackOne.status, "advanced");
  assert.equal(ackOne.previousWatermark, 0);
  assert.equal(ackOne.watermark, 2);
  assert.equal(state.watermark, 2);
  assert.deepEqual(state.pendingVersions, []);

  assert.equal(state.handleNext({ version: 2, data: { value: "two" } }).reason, "below-watermark");
  assert.equal(state.ack(2).status, "already-acknowledged");
});

test("anchors contiguous watermark to the first acknowledged stream version", () => {
  const state = createConnectionState();
  state.handleConnectionAck();
  state.subscribe("sub-1");
  state.handleNext({ version: 42, data: { value: 42 } });
  assert.equal(state.watermark, 0);
  assert.equal(state.ack(42).watermark, 42);

  state.handleNext({ version: 44, data: { value: 44 } });
  assert.equal(state.ack(44).watermark, 42);
  state.handleNext({ version: 43, data: { value: 43 } });
  assert.equal(state.ack(43).watermark, 44);
});

test("supports max watermark mode when requested", () => {
  const state = createConnectionState({ watermarkMode: "max" });
  state.handleConnectionAck();
  state.subscribe("sub-1");
  state.handleNext({ version: 10, data: { value: 10 } });
  state.handleNext({ version: 12, data: { value: 12 } });
  assert.equal(state.ack({ version: 12 }).watermark, 12);
});

test("invalidates late events from the previous socket generation", () => {
  const time = clock();
  const state = createConnectionState({ clock: time.now });
  const first = state.connect("socket-1");
  assert.equal(first.active, true);
  first.handleConnectionAck();
  state.subscribe("sub-1");

  assert.equal(
    first.handleNext({ version: 1, data: { value: "one" } }).status,
    "accepted",
  );
  state.ack(1);

  const second = state.reconnect("socket-2");
  assert.equal(second.generation, 2);
  assert.equal(first.active, false);
  assert.equal(state.watermark, 1);
  assert.equal(state.reconnectRecords.length, 1);
  assert.equal(state.reconnectRecords[0].previousGeneration, 1);
  assert.equal(state.reconnectRecords[0].generation, 2);
  assert.equal(state.reconnectRecords[0].socketId, "socket-2");

  const late = first.handleNext({ version: 2, data: { value: "late" } });
  assert.equal(late.status, "ignored");
  assert.equal(late.reason, "stale-socket");
  const staleRecord = state.dedupeRecords.at(-1);
  assert.equal(staleRecord.reason, "stale-socket");
  assert.equal(staleRecord.version, 2);

  second.handleConnectionAck();
  state.resubscribe("sub-2", { streamId: "default" });
  assert.equal(
    second.handleNext({ version: 1, data: { value: "one" } }, "sub-2").reason,
    "below-watermark",
  );
  assert.equal(
    second.handleNext({ version: 2, data: { value: "two" } }, "sub-2").status,
    "accepted",
  );
  assert.equal(state.ack(2).watermark, 2);

  assert.equal(
    second.handleNext({ version: 3, data: { value: "old-id" } }, "sub-1").reason,
    "unsubscribed",
  );
});

test("rotates keepalive per socket and reports timeout health", () => {
  const time = clock();
  const state = createConnectionState({
    clock: time.now,
    keepaliveTimeoutMs: 100,
  });
  const first = state.connect("ka-1");
  first.handleConnectionAck();
  assert.equal(first.handleKeepalive().count, 1);
  assert.equal(state.lastKeepaliveAt, 1_000);
  assert.equal(state.checkKeepalive().healthy, true);

  time.tick(100);
  assert.equal(state.checkKeepalive().timedOut, true);

  const second = state.reconnect("ka-2");
  const late = first.handleKeepalive();
  assert.equal(late.status, "ignored");
  assert.equal(late.reason, "stale-socket");
  assert.equal(state.keepaliveCount, 0);
  assert.equal(second.handleKeepalive().count, 1);
  assert.equal(state.checkKeepalive().healthy, true);
});

test("exports deterministic, reviewable reconnect and dedupe audit data", () => {
  const time = clock();
  const state = createConnectionState({ clock: time.now });
  const first = state.connect("a");
  first.handleMessage({ type: "connection_ack" });
  first.handleMessage({ type: "subscribe", id: "sub-1" });
  first.handleMessage({
    type: "next",
    id: "sub-1",
    payload: { version: 1, data: { value: "one" } },
  });
  state.acknowledge({ version: 1 });
  first.handleMessage({
    type: "next",
    id: "sub-1",
    payload: { version: 1, data: { value: "one" } },
  });

  const second = state.reconnect("b");
  second.handleMessage({ type: "connection_ack" });
  second.handleMessage({ type: "ka" });
  second.handleMessage({
    type: "next",
    id: "sub-2",
    payload: { version: 1, data: { value: "one" } },
  });
  state.resubscribe("sub-2");
  second.handleMessage({
    type: "next",
    id: "sub-2",
    payload: { version: 1, data: { value: "one" } },
  });

  const audit = state.exportAudit();
  assert.equal(audit.version, 1);
  assert.equal(audit.generation, 2);
  assert.equal(audit.watermark, 1);
  assert.equal(audit.reconnectRecords.length, 1);
  assert.ok(audit.dedupeRecords.length >= 2);
  assert.equal(audit.records[0].sequence, 1);
  assert.equal(
    audit.records.every((record, index) => record.sequence === index + 1),
    true,
  );
  assert.equal(typeof state.reviewAudit(), "string");
  assert.deepEqual(JSON.parse(JSON.stringify(state)), audit);
});

test("can throw on conflicts and exposes dedicated error data", () => {
  const state = createConnectionState({ conflictPolicy: "throw" });
  state.handleConnectionAck();
  state.subscribe("sub-1");
  state.handleNext({ version: 1, data: { value: "a" } });
  assert.throws(
    () => state.handleNext({ version: 1, data: { value: "b" } }),
    (error) => {
      assert.ok(error instanceof EventConflictError);
      assert.equal(error.version, 1);
      assert.deepEqual(error.existingContent, { data: { value: "a" } });
      assert.deepEqual(error.incomingContent, { data: { value: "b" } });
      return true;
    },
  );
  assert.equal(state.conflictCount, 1);
});

test("WatermarkTracker exposes pending and blocked versions", () => {
  const tracker = new WatermarkTracker();
  assert.equal(tracker.observe(2).accepted, true);
  assert.equal(tracker.observe(3).accepted, true);
  assert.equal(tracker.acknowledge(3).advanced, false);
  assert.equal(tracker.watermark, 0);
  assert.deepEqual(tracker.acknowledgedButBlockedVersions, [3]);
  assert.equal(tracker.acknowledge(2).watermark, 3);
  assert.equal(tracker.acknowledge(9).status, "unknown-version");
});

test("supports option callbacks for delivered events and audit outcomes", () => {
  const delivered = [];
  const dedupes = [];
  const reconnects = [];
  const acks = [];
  const state = createConnectionState({
    onEvent: (event) => delivered.push(event.version),
    onDedupe: (record) => dedupes.push(record.reason),
    onReconnect: (record) => reconnects.push(record.generation),
    onAck: (result) => acks.push(result.watermark),
  });
  const socket = state.connect("events-1");
  socket.handleConnectionAck();
  state.subscribe("sub-1");
  socket.handleNext({ version: 1, data: { value: 1 } });
  socket.handleNext({ version: 1, data: { value: 1 } });
  state.ack(1);
  state.reconnect("events-2");

  assert.deepEqual(delivered, [1]);
  assert.deepEqual(dedupes, ["duplicate"]);
  assert.deepEqual(reconnects, [2]);
  assert.deepEqual(acks, [1]);
});

test("reuses subscription stream and payload across reconnect", () => {
  const state = createConnectionState({ autoResubscribe: true });
  const first = state.connect("stream-1");
  first.handleConnectionAck();
  state.subscribe("sub-1", {
    streamId: "orders",
    payload: { query: "subscription { orders { id } }" },
  });
  first.handleNext(
    { version: 1, data: { id: "o-1" }, streamId: "orders" },
    "sub-1",
  );
  assert.equal(state.ack(1, { streamId: "orders" }).watermark, 1);

  const second = state.reconnect("stream-2");
  assert.deepEqual(state.activeSubscriptionIds, []);
  assert.equal(second.handleConnectionAck().status, "acknowledged");
  assert.deepEqual(state.activeSubscriptionIds, ["sub-1"]);

  const event = second.handleNext(
    { version: 2, data: { id: "o-2" }, streamId: "orders" },
    "sub-1",
  );
  assert.equal(event.status, "accepted");
  assert.equal(event.streamId, "orders");
  assert.equal(state.ack({ version: 2 }, { streamId: "orders" }).watermark, 2);
});
