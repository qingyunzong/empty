import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyControlSubject,
  createConsumerStateHandlers,
  JetStreamArchiver,
  JetStreamArchiverError,
  type BackfillRequest,
  type PermanentHole,
} from "./index.js";

test("publishes contiguous messages and keeps stream/consumer cursors separate", () => {
  const records: Array<[number, number | undefined, unknown]> = [];
  const commits: Array<[number, number]> = [];
  const archiver = new JetStreamArchiver({
    publish: (record) => {
      records.push([record.streamSeq, record.consumerSeq, record.data]);
    },
    onCommit: (commit) => {
      commits.push([commit.streamSeq, commit.consumerSeq]);
    },
  });

  archiver.ingest({ seq: 1, deliverySeq: 11, data: "one" });
  archiver.ingest({ seq: 2, deliverySeq: 12, data: "two" });

  assert.deepEqual(records, [
    [1, 11, "one"],
    [2, 12, "two"],
  ]);
  assert.deepEqual(commits, [
    [1, 11],
    [2, 12],
  ]);
  assert.equal(archiver.snapshot().stream.committedSeq, 2);
  assert.equal(archiver.snapshot().consumer.highestObservedSeq, 12);
});

test("pauses commits on a stream gap and requests its range once", () => {
  const published: number[] = [];
  const requests: BackfillRequest[] = [];
  const commits: number[] = [];
  const archiver = new JetStreamArchiver({
    publish: (record) => published.push(record.streamSeq),
    requestBackfill: (request) => requests.push(request),
    onCommit: (commit) => commits.push(commit.streamSeq),
  });

  archiver.ingest({ seq: 1, consumerSeq: 1, data: "one" });
  const result = archiver.ingest({ seq: 5, consumerSeq: 2, data: "five" });
  archiver.ingest({ seq: 6, consumerSeq: 3, data: "six" });

  assert.deepEqual(result.gap, { start: 2, end: 4 });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].range, { start: 2, end: 4 });
  assert.deepEqual(published, [1]);
  assert.deepEqual(commits, [1]);
  assert.equal(archiver.snapshot().stream.commitPaused, true);

  const backfill = archiver.handleBackfill({
    messages: [
      { seq: 4, data: "four" },
      { seq: 2, data: "two" },
      { seq: 3, data: "three" },
    ],
    complete: true,
  });

  assert.equal(backfill.resolved, true);
  assert.deepEqual(published, [1, 2, 3, 4, 5, 6]);
  assert.equal(archiver.snapshot().stream.commitPaused, false);
  assert.equal(archiver.snapshot().stream.nextSeq, 7);
});

test("interleaves live and backfilled records strictly by stream sequence", () => {
  const published: number[] = [];
  const archiver = new JetStreamArchiver({
    startStreamSeq: 2,
    publish: (record) => published.push(record.streamSeq),
  });

  archiver.ingest({ seq: 5, consumerSeq: 1, data: "five" });
  archiver.ingest({ seq: 8, consumerSeq: 2, data: "eight" });
  archiver.handleBackfill({
    messages: [
      { seq: 2, data: "two" },
      { streamSequence: 4, data: "four" },
      { seq: 3, data: "three" },
    ],
    complete: true,
  });
  archiver.handleBackfill({
    messages: [
      { seq: 6, data: "six" },
      { seq: 7, data: "seven" },
    ],
    complete: true,
  });

  assert.deepEqual(published, [2, 3, 4, 5, 6, 7, 8]);
});

test("records inferred and explicit permanent holes", () => {
  const holes: PermanentHole[] = [];
  const published: number[] = [];
  const archiver = new JetStreamArchiver({
    publish: (record) => published.push(record.streamSeq),
    onPermanentHole: (hole) => holes.push(hole),
  });

  archiver.ingest({ seq: 1, consumerSeq: 1, data: "one" });
  archiver.ingest({ seq: 10, consumerSeq: 2, data: "ten" });
  archiver.handleBackfill({
    messages: [
      { seq: 2, data: "two" },
      { seq: 8, data: "eight" },
    ],
    holes: [4],
    complete: true,
  });

  assert.deepEqual(published, [1, 2, 8, 10]);
  assert.equal(holes.length, 2);
  assert.deepEqual(
    archiver
      .snapshot()
      .permanentHoles.map((hole) => [hole.start, hole.end, hole.reason]),
    [
      [3, 7, "deleted"],
      [9, 9, "deleted"],
    ],
  );
  assert.equal(archiver.snapshot().stream.committedSeq, 10);
  assert.equal(archiver.snapshot().stream.pending, 0);
});

test("does not commit a partially specified backfill", () => {
  const published: number[] = [];
  const archiver = new JetStreamArchiver({
    publish: (record) => published.push(record.streamSeq),
    requestBackfill: () => {},
  });

  archiver.ingest({ seq: 1, consumerSeq: 1, data: "one" });
  archiver.ingest({ seq: 5, consumerSeq: 2, data: "five" });
  const partial = archiver.handleBackfill({
    messages: [{ seq: 2, data: "two" }],
    complete: false,
  });

  assert.equal(partial.resolved, false);
  assert.deepEqual(published, [1]);
  assert.equal(archiver.snapshot().stream.commitPaused, true);

  const complete = archiver.handleBackfill({
    messages: [
      { seq: 3, data: "three" },
      { seq: 4, data: "four" },
    ],
    complete: true,
  });
  assert.equal(complete.resolved, true);
  assert.deepEqual(published, [1, 2, 3, 4, 5]);
});

test("redelivery advances consumer sequence without republishing stream data", () => {
  const published: number[] = [];
  const archiver = new JetStreamArchiver({
    publish: (record) => published.push(record.streamSeq),
  });

  archiver.ingest({ seq: 1, consumerSeq: 1, data: "one" });
  const duplicate = archiver.ingest({
    seq: 1,
    consumerSeq: 2,
    redelivery: true,
    data: "one",
  });

  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(published, [1]);
  assert.equal(archiver.snapshot().consumer.highestObservedSeq, 2);
  assert.equal(archiver.snapshot().stream.committedSeq, 1);
  assert.equal(archiver.snapshot().consumer.redeliveries, 1);
});

test("live redeliveries can close a gap without a duplicate backfill request", () => {
  const requests: SequenceRangeLike[] = [];
  const published: number[] = [];
  const archiver = new JetStreamArchiver({
    publish: (record) => published.push(record.streamSeq),
    requestBackfill: (request) => requests.push(request.range),
  });

  archiver.ingest({ seq: 4, consumerSeq: 1, redelivery: true, data: "four" });
  for (let seq = 1; seq <= 3; seq += 1) {
    archiver.ingest({
      seq,
      consumerSeq: seq + 1,
      redelivery: true,
      data: String(seq),
    });
  }

  assert.deepEqual(requests, [{ start: 1, end: 3 }]);
  assert.deepEqual(published, [1, 2, 3, 4]);
  assert.equal(archiver.snapshot().stream.commitPaused, false);
});

test("flow control and heartbeat do not disturb application sequences", () => {
  const archiver = new JetStreamArchiver({ now: () => 5_000 });
  archiver.ingest({ seq: 1, consumerSeq: 1, data: "one" });

  assert.equal(classifyControlSubject("$JS.FC.consumer"), "flow-control");
  assert.equal(classifyControlSubject("$JS.HEARTBEAT"), "heartbeat");
  assert.equal(classifyControlSubject("orders.created"), undefined);

  archiver.handleControlMessage(
    "$JS.FC.consumer",
    new TextEncoder().encode('{"stream":99}'),
  );
  archiver.handleControlMessage("$JS.HEARTBEAT", undefined, 4_000);

  const snapshot = archiver.snapshot();
  assert.equal(snapshot.stream.committedSeq, 1);
  assert.equal(snapshot.consumer.committedSeq, 1);
  assert.equal(snapshot.flowControl.count, 1);
  assert.equal(snapshot.flowControl.lastStreamSequence, 99);
  assert.equal(snapshot.heartbeat.count, 1);
  assert.equal(snapshot.heartbeat.lastAt, 4_000);
  assert.equal(archiver.isHeartbeatStale(1_000, 5_000), false);
});

test("rejects a stale backfill request while another gap is active", () => {
  const archiver = new JetStreamArchiver({ requestBackfill: () => {} });
  archiver.ingest({ seq: 3, consumerSeq: 1, data: "three" });

  assert.throws(
    () => archiver.handleBackfill({ requestId: 99 }),
    (error: unknown) =>
      error instanceof JetStreamArchiverError &&
      error.code === "BACKFILL_REQUEST_MISMATCH",
  );
});

test("consumer-state handlers route all frame types", () => {
  const published: number[] = [];
  const archiver = new JetStreamArchiver({
    publish: (record) => published.push(record.streamSeq),
  });
  const handlers = createConsumerStateHandlers(archiver);

  handlers.message({ streamSeq: 1, consumerSeq: 1, data: "one" });
  handlers.heartbeat(100);
  handlers.flowControl({ stream: 1 });

  assert.deepEqual(published, [1]);
  assert.equal(archiver.snapshot().heartbeat.count, 1);
  assert.equal(archiver.snapshot().flowControl.count, 1);
});

interface SequenceRangeLike {
  start: number;
  end: number;
}
