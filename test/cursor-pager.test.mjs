import assert from "node:assert/strict";
import test from "node:test";

import {
  CursorLoopError,
  CursorPager,
  InvalidCursorError,
  SnapshotExpiredError,
  SnapshotRecoveryError,
  collectCursorPages,
} from "../.test-build/index.js";

function row(id, version, value) {
  return { id, version, value };
}

function keyedPages(pages) {
  return async ({ cursor }) => {
    const page = pages[String(cursor)];
    if (page === undefined) {
      throw new Error(`Unexpected cursor: ${String(cursor)}`);
    }
    return page;
  };
}

function memoryStore(initial = null) {
  let current = initial;
  const saved = [];
  return {
    saved,
    store: {
      async load() {
        return current;
      },
      async save(checkpoint) {
        current = { ...checkpoint };
        saved.push({ ...checkpoint });
      },
    },
  };
}

test("deduplicates overlap, replaces uncommitted versions and emits each key once", async () => {
  const seen = [];
  const pager = new CursorPager({
    fetchPage: keyedPages({
      null: {
        items: [row("a", 1), row("b", 1)],
        nextCursor: "p2",
        snapshotToken: "snap-1",
      },
      p2: {
        items: [row("b", 1), row("a", 2), row("c", 1)],
        nextCursor: "p3",
      },
      p3: {
        items: [row("c", 0), row("a", 3), row("b", 2)],
        nextCursor: null,
      },
    }),
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
    batchSize: 100,
    onBatch(records, batch) {
      seen.push(...records);
      assert.equal(batch.replaced, 3);
      assert.equal(batch.duplicatesSkipped, 2);
    },
  });

  const summary = await pager.run();
  assert.deepEqual(
    seen.map((item) => [item.id, item.version]),
    [
      ["a", 3],
      ["b", 2],
      ["c", 1],
    ],
  );
  assert.equal(summary.records, 3);
  assert.equal(summary.stopReason, "end");
  assert.equal(summary.checkpoint.watermark, 3);
  assert.equal(summary.checkpoint.cursor, null);
  assert.equal(summary.checkpoint.exhausted, true);
});

test("stops a cursor loop instead of spinning or re-emitting records", async () => {
  const seen = [];
  const pager = new CursorPager({
    fetchPage: keyedPages({
      null: {
        items: [row("a", 1)],
        nextCursor: "p2",
      },
      p2: {
        items: [row("b", 1), row("a", 1)],
        nextCursor: "p1",
      },
      p1: { items: [], nextCursor: "p2" },
    }),
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
    onBatch(records) {
      seen.push(...records);
    },
  });

  const summary = await pager.run();
  assert.deepEqual(
    seen.map((item) => item.id),
    ["a", "b"],
  );
  assert.equal(summary.stopReason, "cursor-loop");
});

test("throws CursorLoopError when the caller requests strict loop handling", async () => {
  const pager = new CursorPager({
    fetchPage: keyedPages({
      null: { items: [row("a", 1)], nextCursor: "p2" },
      p2: { items: [row("b", 1)], nextCursor: "p1" },
      p1: { items: [], nextCursor: "p2" },
    }),
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
    cursorLoopPolicy: "throw",
  });

  await assert.rejects(() => pager.nextBatch(), CursorLoopError);
  // The failure rewinds to the committed checkpoint.
  assert.equal(pager.checkpoint.cursor, null);
});

test("does not request a cursor that would repeat the current page", async () => {
  let fetches = 0;
  const pager = new CursorPager({
    fetchPage: async () => {
      fetches += 1;
      if (fetches === 1) {
        return { items: [row("a", 1)], nextCursor: "again" };
      }
      return { items: [row("b", 1), row("a", 1)], nextCursor: "again" };
    },
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
  });

  const batch = await pager.nextBatch();
  assert.notEqual(batch, null);
  assert.deepEqual(
    batch.records.map((item) => item.id),
    ["a", "b"],
  );
  assert.equal(batch.stopReason, "cursor-loop");
  assert.equal(fetches, 2);
});

test("snapshot expiry before any commit discards the uncommitted batch and refetches", async () => {
  let expired = false;
  const seen = [];
  const pager = new CursorPager({
    fetchPage: async ({ cursor, snapshotToken }) => {
      if (cursor === null) {
        assert.notEqual(snapshotToken, "snap-1", "expired token must be replaced");
        return {
          items: [row("a", 1)],
          nextCursor: "p2",
          snapshotToken: "snap-2",
        };
      }

      if (!expired) {
        expired = true;
        throw new SnapshotExpiredError("snapshot token expired", {
          snapshotToken: "snap-2",
        });
      }
      assert.equal(snapshotToken, "snap-2");
      return { items: [row("b", 1), row("c", 1)], nextCursor: null };
    },
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
    onBatch(records) {
      seen.push(...records);
    },
  });

  const summary = await pager.run();
  assert.deepEqual(
    seen.map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.equal(summary.snapshotRecoveries, 1);
});

test("snapshot expiry after a commit resumes from cursor + watermark without duplicates", async () => {
  const memory = memoryStore();
  const seen = [];
  const pager = new CursorPager({
    fetchPage: async ({ cursor, snapshotToken }) => {
      if (cursor === null) {
        return {
          items: [row("a", 1)],
          nextCursor: "p2",
          snapshotToken: "snap-1",
        };
      }
      if (snapshotToken === "snap-1") {
        throw { code: "SNAPSHOT_TOKEN_EXPIRED", message: "expired" };
      }
      return {
        items: [row("b", 1), row("c", 1)],
        nextCursor: null,
        snapshotToken: "snap-2",
      };
    },
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
    batchSize: 1,
    checkpointStore: memory.store,
    onBatch(records) {
      seen.push(...records);
    },
  });

  const summary = await pager.run();
  assert.deepEqual(
    seen.map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.equal(summary.snapshotRecoveries, 1);
  assert.equal(memory.saved.length, 2);
  assert.deepEqual(
    {
      cursor: memory.saved[0].cursor,
      watermark: memory.saved[0].watermark,
      snapshotToken: memory.saved[0].snapshotToken,
      exhausted: memory.saved[0].exhausted,
    },
    {
      cursor: "p2",
      watermark: 1,
      snapshotToken: "snap-1",
      exhausted: false,
    },
  );
  assert.equal(memory.saved[1].cursor, null);
  assert.equal(memory.saved[1].watermark, 1);
  assert.equal(memory.saved[1].exhausted, true);
});

test("a restarted pager resumes at the durable checkpoint without re-emitting confirmed records", async () => {
  const memory = memoryStore();
  const options = {
    fetchPage: keyedPages({
      null: {
        items: [row("a", 1)],
        nextCursor: "p2",
        snapshotToken: "snap-1",
      },
      p2: {
        items: [row("b", 1), row("c", 1)],
        nextCursor: null,
      },
    }),
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
    batchSize: 1,
    checkpointStore: memory.store,
  };

  const first = new CursorPager(options);
  const firstBatch = await first.nextBatch();
  assert.deepEqual(
    firstBatch?.records.map((item) => item.id),
    ["a"],
  );
  await first.commit(firstBatch);

  const seen = [];
  const second = new CursorPager({
    ...options,
    onBatch(records) {
      seen.push(...records);
    },
  });
  await second.run();
  assert.deepEqual(
    seen.map((item) => item.id),
    ["b", "c"],
  );
});

test("restart policy rescans from the beginning but filters the committed watermark", async () => {
  const memory = memoryStore({
    cursor: "p2",
    watermark: 1,
    watermarkKeys: ["a"],
    snapshotToken: "old-snapshot",
    exhausted: false,
  });
  const seen = [];
  const pager = new CursorPager({
    fetchPage: async ({ cursor, snapshotToken }) => {
      if (cursor === "p2" && snapshotToken === "old-snapshot") {
        throw new SnapshotExpiredError("snapshot expired");
      }
      if (cursor === null) {
        return {
          items: [row("a", 3), row("b", 1)],
          nextCursor: "p2",
          snapshotToken: "new-snapshot",
        };
      }
      return {
        items: [row("c", 1)],
        nextCursor: null,
        snapshotToken: "new-snapshot",
      };
    },
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
    checkpointStore: memory.store,
    snapshotExpiryPolicy: "restart",
    onBatch(records) {
      seen.push(...records);
    },
  });

  await pager.run();
  assert.deepEqual(
    seen.map((item) => [item.id, item.version]),
    [
      ["a", 3],
      ["b", 1],
      ["c", 1],
    ],
  );
});

test("a confirmed key without versions is not re-emitted from a later overlapping page", async () => {
  const make = (id) => ({ id });
  const seen = [];
  const pager = new CursorPager({
    fetchPage: async ({ cursor }) =>
      cursor === null
        ? { items: [make("a")], nextCursor: "p2" }
        : { items: [make("a"), make("b")], nextCursor: null },
    getKey: (item) => item.id,
    batchSize: 1,
    onBatch(records) {
      seen.push(...records.map((item) => item.id));
    },
  });

  await pager.run();
  assert.deepEqual(seen, ["a", "b"]);
});

test("maxPages pauses at a resumable cursor instead of marking the scan exhausted", async () => {
  const memory = memoryStore();
  const seen = [];
  const options = {
    fetchPage: keyedPages({
      null: { items: [row("a", 1)], nextCursor: "p2" },
      p2: { items: [row("b", 1)], nextCursor: "p3" },
      p3: { items: [row("c", 1)], nextCursor: null },
    }),
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
    batchSize: 1,
    maxPages: 2,
    checkpointStore: memory.store,
    onBatch(records) {
      seen.push(...records.map((item) => item.id));
    },
  };

  const first = new CursorPager(options);
  const firstSummary = await first.run();
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(firstSummary.stopReason, "max-pages");
  assert.equal(memory.saved.at(-1).cursor, "p3");
  assert.equal(memory.saved.at(-1).exhausted, false);

  const second = new CursorPager(options);
  const secondSummary = await second.run();
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(secondSummary.records, 1);
  assert.equal(secondSummary.checkpoint.exhausted, true);
});

test("a failed checkpoint save leaves the batch retryable", async () => {
  let fail = true;
  const saved = [];
  const pager = new CursorPager({
    fetchPage: keyedPages({
      null: { items: [row("a", 1)], nextCursor: null },
    }),
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
    checkpointStore: {
      async load() {
        return null;
      },
      async save(checkpoint) {
        if (fail) {
          throw new Error("disk unavailable");
        }
        saved.push({ ...checkpoint });
      },
    },
  });

  const batch = await pager.nextBatch();
  await assert.rejects(() => pager.commit(batch), /disk unavailable/);
  assert.equal(pager.checkpoint.cursor, null);

  fail = false;
  await pager.commit(batch);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].watermark, 1);
  assert.equal(pager.checkpoint.exhausted, true);
  // A repeated successful commit is idempotent.
  await pager.commit(batch);
  assert.equal(saved.length, 1);
});

test("abort discards uncommitted work and refetches from the checkpoint", async () => {
  let fetches = 0;
  const pager = new CursorPager({
    fetchPage: async () => {
      fetches += 1;
      return { items: [row("a", 1)], nextCursor: null };
    },
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
  });

  const first = await pager.nextBatch();
  assert.equal(first.records.length, 1);
  pager.abort();
  const second = await pager.nextBatch();
  assert.equal(second.records.length, 1);
  assert.equal(fetches, 2);
});

test("invalid checkpoint cursor falls back to a watermark-filtered rescan", async () => {
  const seen = [];
  const pager = new CursorPager({
    fetchPage: async ({ cursor }) => {
      if (cursor === "gone") {
        throw new InvalidCursorError();
      }
      if (cursor === null) {
        return {
          items: [row("a", 1), row("b", 1)],
          nextCursor: "p2",
          snapshotToken: "new-snapshot",
        };
      }
      return { items: [row("c", 1)], nextCursor: null };
    },
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
    initialCheckpoint: {
      cursor: "gone",
      watermark: 1,
      watermarkKeys: ["a"],
      snapshotToken: "old-snapshot",
    },
    onBatch(records) {
      seen.push(...records.map((item) => item.id));
    },
  });

  const summary = await pager.run();
  assert.deepEqual(seen, ["b", "c"]);
  assert.equal(summary.snapshotRecoveries, 1);
});

test("repeated snapshot expiry is bounded", async () => {
  let fetches = 0;
  const pager = new CursorPager({
    fetchPage: async () => {
      fetches += 1;
      throw new SnapshotExpiredError("expired again");
    },
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
    maxSnapshotRecoveries: 2,
  });

  await assert.rejects(() => pager.nextBatch(), SnapshotRecoveryError);
  assert.equal(fetches, 3);
});

test("collectCursorPages is importable and handles an ordinary scan", async () => {
  const records = await collectCursorPages({
    fetchPage: keyedPages({
      null: { items: [row("a", 1), row("b", 1)], nextCursor: "p2" },
      p2: { items: [row("b", 1), row("c", 1)], nextCursor: null },
    }),
    getKey: (item) => item.id,
    getVersion: (item) => item.version,
  });
  assert.deepEqual(
    records.map((item) => item.id),
    ["a", "b", "c"],
  );
});
