import assert from "node:assert/strict";
import test from "node:test";

import {
  SnapshotIncrementalCoordinator,
  type BookPublication,
  type CoordinatorError,
  type CoordinatorOptions,
  type OrderBook,
  type OrderBookSnapshot,
  type SnapshotRequest,
} from "../index.ts";

function createHarness(options: CoordinatorOptions = {}) {
  const books: OrderBook[] = [];
  const publications: BookPublication[] = [];
  const requests: SnapshotRequest[] = [];
  const errors: CoordinatorError[] = [];

  const coordinator = new SnapshotIncrementalCoordinator({
    requestSnapshot: (request) => {
      requests.push(request);
    },
    onBook: (book, publication) => {
      books.push(book);
      publications.push(publication);
    },
    onError: (error) => {
      errors.push(error);
    },
    ...options,
  });

  return { coordinator, books, publications, requests, errors };
}

function snapshot(
  sequence: number,
  bids: readonly (readonly [number, number])[] = [],
  asks: readonly (readonly [number, number])[] = [],
  channel = "BTC-USD",
): OrderBookSnapshot {
  return { channel, sequence, bids, asks };
}

test("applies a snapshot and only contiguous deltas", () => {
  const { coordinator, books } = createHarness();

  const applied = coordinator.handleSnapshot(
    snapshot(
      100,
      [
        [100, 1],
        [99, 2],
      ],
      [
        [101, 1],
        [102, 2],
      ],
    ),
  );

  assert.equal(applied.status, "applied");
  assert.equal(coordinator.getBook("BTC-USD")?.sequence, 100);
  assert.deepEqual(coordinator.getBook("BTC-USD")?.bids, [
    { price: 100, size: 1 },
    { price: 99, size: 2 },
  ]);
  assert.deepEqual(coordinator.getBook("BTC-USD")?.asks, [
    { price: 101, size: 1 },
    { price: 102, size: 2 },
  ]);

  const delta = coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 101,
    bids: [
      [100, 0],
      ["99", "3"],
    ],
    asks: [{ price: 101, size: 4 }],
  });

  assert.deepEqual(delta, { status: "applied", sequence: 101 });
  assert.equal(coordinator.getBook("BTC-USD")?.sequence, 101);
  assert.deepEqual(coordinator.getBook("BTC-USD")?.bids, [
    { price: 99, size: 3 },
  ]);
  assert.deepEqual(coordinator.getBook("BTC-USD")?.asks, [
    { price: 101, size: 4 },
    { price: 102, size: 2 },
  ]);

  assert.deepEqual(
    coordinator.handleDelta({ channel: "BTC-USD", sequence: 101 }),
    { status: "duplicate", sequence: 101 },
  );
  assert.deepEqual(
    coordinator.handleSnapshot(snapshot(101, [[99, 3]], [[101, 4]])),
    { status: "duplicate", sequence: 101 },
  );
  assert.equal(books.length, 2);
});

test("buffers before the first snapshot and replays only the contiguous run", () => {
  const { coordinator, books, requests } = createHarness({
    maxBufferedDeltas: 8,
  });

  assert.deepEqual(
    coordinator.handleDelta({
      channel: "BTC-USD",
      sequence: 102,
      bids: [[100, 1]],
    }),
    { status: "buffered", sequence: 102, bufferedDeltas: 1 },
  );
  assert.equal(requests[0]?.reason, "no-snapshot");

  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 103,
    bids: [[100, 2]],
  });
  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 105,
    asks: [[101, 5]],
  });

  // Redelivery of an already buffered delta does not add a second entry.
  assert.deepEqual(
    coordinator.handleDelta({
      channel: "BTC-USD",
      sequence: 103,
      bids: [[100, 99]],
    }),
    { status: "duplicate", sequence: 103 },
  );
  assert.equal(coordinator.getState("BTC-USD")?.bufferedDeltas, 3);

  const result = coordinator.handleSnapshot(
    snapshot(101, [[100, 1]], [[101, 1]]),
  );

  assert.deepEqual(result, {
    status: "applied",
    sequence: 101,
    replayedDeltas: 2,
    resyncRequired: true,
  });
  assert.deepEqual(
    books.map((book) => book.sequence),
    [101, 102, 103],
  );
  assert.equal(coordinator.isSynchronized("BTC-USD"), false);
  assert.deepEqual(coordinator.getState("BTC-USD"), {
    channel: "BTC-USD",
    phase: "awaiting-snapshot",
    synchronized: false,
    lastSequence: 103,
    snapshotSequence: 101,
    bufferedDeltas: 1,
    snapshotRequestPending: true,
  });
  assert.deepEqual(
    requests.map((request) => request.reason),
    ["no-snapshot", "gap"],
  );

  // 104 bridges the gap, then a snapshot at the current baseline replays both.
  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 104,
    bids: [[100, 0]],
  });
  const recovered = coordinator.handleSnapshot(
    snapshot(103, [[100, 2]], [[101, 1]]),
  );
  assert.deepEqual(recovered, {
    status: "applied",
    sequence: 103,
    replayedDeltas: 2,
    resyncRequired: false,
  });
  assert.deepEqual(
    books.map((book) => book.sequence),
    [101, 102, 103, 103, 104, 105],
  );
  assert.equal(coordinator.isSynchronized("BTC-USD"), true);
});

test("drops buffered deltas already covered by an arriving snapshot", () => {
  const { coordinator, books } = createHarness();

  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 100,
    bids: [[100, 1]],
  });
  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 101,
    bids: [[100, 2]],
  });

  const result = coordinator.handleSnapshot(
    snapshot(101, [[100, 5]], [[101, 1]]),
  );

  assert.deepEqual(result, {
    status: "applied",
    sequence: 101,
    replayedDeltas: 0,
    resyncRequired: false,
  });
  assert.deepEqual(
    books.map((book) => book.sequence),
    [101],
  );
  assert.equal(coordinator.getState("BTC-USD")?.bufferedDeltas, 0);
});

test("reconnect buffers bounded deltas and replays after the snapshot", () => {
  const { coordinator, books, publications, requests } = createHarness({
    maxBufferedDeltas: 4,
  });

  coordinator.handleSnapshot(snapshot(100, [[100, 1]], [[101, 1]]));
  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 101,
    bids: [[100, 2]],
  });

  coordinator.beginReconnect("BTC-USD");
  assert.equal(requests.at(-1)?.reason, "reconnect");
  assert.equal(coordinator.isSynchronized("BTC-USD"), false);

  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 102,
    bids: [[100, 3]],
  });
  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 103,
    bids: [[100, 4]],
  });
  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 104,
    asks: [[101, 0], [102, 2]],
  });

  // No book is published while the socket is not synchronized.
  assert.equal(books.length, 2);
  assert.equal(coordinator.getState("BTC-USD")?.bufferedDeltas, 3);

  const result = coordinator.handleSnapshot(
    snapshot(101, [[100, 2]], [[101, 1]]),
  );

  assert.deepEqual(result, {
    status: "applied",
    sequence: 101,
    replayedDeltas: 3,
    resyncRequired: false,
  });
  assert.deepEqual(
    books.map((book) => book.sequence),
    [100, 101, 101, 102, 103, 104],
  );
  assert.equal(publications.at(-1)?.replayed, true);
  assert.equal(coordinator.getBook("BTC-USD")?.sequence, 104);
  assert.deepEqual(coordinator.getBook("BTC-USD")?.asks, [
    { price: 102, size: 2 },
  ]);

  // Redelivered deltas and an older snapshot cannot move the book backwards.
  assert.deepEqual(
    coordinator.handleDelta({ channel: "BTC-USD", sequence: 103 }),
    { status: "duplicate", sequence: 103 },
  );
  assert.deepEqual(
    coordinator.handleSnapshot(snapshot(99, [[1, 1]], [[2, 1]])),
    { status: "stale", sequence: 99, lastSequence: 104 },
  );
  assert.equal(coordinator.getBook("BTC-USD")?.sequence, 104);
});

test("a live gap requests a snapshot without applying the gap delta", () => {
  const { coordinator, books, requests } = createHarness();

  coordinator.handleSnapshot(snapshot(100, [[100, 1]], [[101, 1]]));
  const gap = coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 102,
    bids: [[100, 9]],
  });

  assert.deepEqual(gap, { status: "resync", sequence: 102, reason: "gap" });
  assert.equal(requests.at(-1)?.reason, "gap");
  assert.equal(books.length, 1);
  assert.equal(coordinator.getBook("BTC-USD")?.sequence, 100);

  // The missing delta arrives late. It is buffered, not applied immediately.
  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 101,
    bids: [[100, 2]],
  });
  assert.equal(books.length, 1);

  const result = coordinator.handleSnapshot(
    snapshot(101, [[100, 2]], [[101, 1]]),
  );
  assert.equal(result.status, "applied");
  // Snapshot 101 already includes the late delta 101, so only 102 is replayed.
  assert.equal(result.status === "applied" && result.replayedDeltas, 1);
  assert.deepEqual(
    books.map((book) => book.sequence),
    [100, 101, 102],
  );
  assert.deepEqual(coordinator.getBook("BTC-USD")?.bids, [
    { price: 100, size: 9 },
  ]);
});

test("buffer overflow requests a snapshot and never publishes a partial book", () => {
  const { coordinator, books, requests } = createHarness({
    maxBufferedDeltas: 2,
  });

  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 100,
    bids: [[100, 1]],
  });
  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 101,
    bids: [[100, 2]],
  });

  const overflow = coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 102,
    bids: [[100, 3]],
  });

  assert.deepEqual(overflow, {
    status: "resync",
    sequence: 102,
    reason: "buffer-overflow",
  });
  assert.equal(requests.at(-1)?.reason, "buffer-overflow");
  assert.equal(books.length, 0);
  assert.deepEqual(coordinator.getState("BTC-USD"), {
    channel: "BTC-USD",
    phase: "awaiting-snapshot",
    synchronized: false,
    lastSequence: null,
    snapshotSequence: null,
    bufferedDeltas: 1,
    snapshotRequestPending: true,
  });

  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 103,
    bids: [[100, 4]],
  });
  assert.equal(books.length, 0);

  const result = coordinator.handleSnapshot(
    snapshot(101, [[100, 2]], [[101, 1]]),
  );
  assert.deepEqual(result, {
    status: "applied",
    sequence: 101,
    replayedDeltas: 2,
    resyncRequired: false,
  });
  assert.deepEqual(
    books.map((book) => book.sequence),
    [101, 102, 103],
  );
});

test("overflow with a zero-sized buffer drops deltas but still recovers", () => {
  const { coordinator, books, requests } = createHarness({
    maxBufferedDeltas: 0,
  });

  assert.equal(
    coordinator.handleDelta({
      channel: "BTC-USD",
      sequence: 10,
      bids: [[100, 1]],
    }).status,
    "resync",
  );
  assert.equal(requests.at(-1)?.reason, "buffer-overflow");
  assert.equal(coordinator.getState("BTC-USD")?.bufferedDeltas, 0);
  assert.equal(books.length, 0);

  coordinator.handleSnapshot(snapshot(9, [[100, 1]], [[101, 1]]));
  assert.deepEqual(
    books.map((book) => book.sequence),
    [9],
  );
  assert.equal(
    coordinator.handleDelta({
      channel: "BTC-USD",
      sequence: 10,
      bids: [[100, 2]],
    }).status,
    "applied",
  );
  assert.equal(
    coordinator.handleDelta({
      channel: "BTC-USD",
      sequence: 12,
      bids: [[100, 3]],
    }).status,
    "resync",
  );
  assert.equal(requests.at(-1)?.reason, "buffer-overflow");
  assert.equal(coordinator.getBook("BTC-USD")?.sequence, 10);
});

test("stale snapshot responses trigger another request while resyncing", () => {
  const { coordinator, requests } = createHarness();

  coordinator.handleSnapshot(snapshot(100, [[100, 1]], [[101, 1]]));
  coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 101,
    bids: [[100, 2]],
  });

  coordinator.beginReconnect("BTC-USD");
  const stale = coordinator.handleSnapshot(
    snapshot(99, [[100, 7]], [[101, 7]]),
  );

  assert.deepEqual(stale, {
    status: "stale",
    sequence: 99,
    lastSequence: 101,
  });
  assert.equal(requests.at(-1)?.reason, "stale-snapshot");
  assert.equal(coordinator.isSynchronized("BTC-USD"), false);
  assert.equal(coordinator.getState("BTC-USD")?.lastSequence, 101);

  const recovered = coordinator.handleSnapshot(
    snapshot(101, [[100, 2]], [[101, 1]]),
  );
  assert.equal(recovered.status, "applied");
  assert.equal(coordinator.isSynchronized("BTC-USD"), true);
});

test("channels are synchronized independently", () => {
  const { coordinator, books } = createHarness();

  coordinator.handleMessage({
    type: "snapshot",
    channel: "BTC-USD",
    sequence: 100,
    bids: [[100, 1]],
    asks: [[101, 1]],
  });
  coordinator.handleSnapshot(
    snapshot(200, [[10, 1]], [[11, 1]], "ETH-USD"),
  );

  coordinator.handleMessage({
    type: "update",
    channel: "BTC-USD",
    sequence: 101,
    bids: [[100, 2]],
  });
  coordinator.handleMessage({
    type: "delta",
    channel: "ETH-USD",
    sequence: 201,
    asks: [[11, 3]],
  });
  coordinator.handleMessage({
    type: "increment",
    channel: "ETH-USD",
    sequence: 203,
    asks: [[12, 1]],
  });

  assert.equal(coordinator.isSynchronized("BTC-USD"), true);
  assert.equal(coordinator.isSynchronized("ETH-USD"), false);
  assert.equal(coordinator.getBook("BTC-USD")?.sequence, 101);
  assert.equal(coordinator.getBook("ETH-USD")?.sequence, 201);
  assert.deepEqual(
    books.map((book) => `${book.channel}:${book.sequence}`),
    ["BTC-USD:100", "ETH-USD:200", "BTC-USD:101", "ETH-USD:201"],
  );
});

test("invalid messages are rejected without changing state", () => {
  const { coordinator, books, errors } = createHarness();

  const badSequence = coordinator.handleSnapshot({
    channel: "BTC-USD",
    sequence: -1,
    bids: [],
    asks: [],
  });
  assert.equal(badSequence.status, "invalid");
  assert.equal(coordinator.getState("BTC-USD"), undefined);

  coordinator.handleSnapshot(snapshot(50, [[100, 1]], [[101, 1]]));
  const badLevel = coordinator.handleDelta({
    channel: "BTC-USD",
    sequence: 51,
    bids: [[100, -2]],
  });
  assert.equal(badLevel.status, "invalid");
  assert.equal(coordinator.getBook("BTC-USD")?.sequence, 50);
  assert.equal(books.length, 1);

  const badMessage = coordinator.handleMessage({
    type: "trade",
  } as never);
  assert.equal(badMessage.status, "invalid");
  assert.deepEqual(
    errors.map((error) => error.code),
    ["invalid-snapshot", "invalid-delta", "invalid-message"],
  );

  assert.throws(
    () => new SnapshotIncrementalCoordinator({ maxBufferedDeltas: -1 }),
    /maxBufferedDeltas/,
  );
});

test("getBook returns a defensive copy", () => {
  const { coordinator } = createHarness();

  coordinator.handleSnapshot(snapshot(1, [[100, 1]], [[101, 1]]));
  const book = coordinator.getBook("BTC-USD");
  assert.ok(book);

  (book.bids[0] as { size: number }).size = 999;
  assert.equal(coordinator.getBook("BTC-USD")?.bids[0]?.size, 1);
});
