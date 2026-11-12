import assert from "node:assert/strict";
import test from "node:test";

import {
  compareIdBytes,
  IncrementalTimeCollector,
  InMemoryCheckpointStore,
  INT64_MAX,
  INT64_MIN,
  RemoteContractError,
  splitTimeInterval,
} from "../index.ts";
import type {
  BucketDelivery,
  Checkpoint,
  CheckpointStore,
  CollectedRecord,
  DeliveryEvidence,
  NextResult,
} from "../src/types.ts";
import type { CollectorSession } from "../src/collector.ts";
import { FakeRemote, type FakeRecord } from "./fake-remote.ts";

function makeRecord(
  id: string,
  time: bigint,
  content: unknown = id,
): FakeRecord {
  return { id, time, content };
}

function sortedModel(records: readonly FakeRecord[]): FakeRecord[] {
  return records.slice().sort((left, right) => {
    if (left.time !== right.time) {
      return left.time < right.time ? -1 : 1;
    }
    return compareIdBytes(left.id, right.id);
  });
}

function assertBucketOrdering(bucket: BucketDelivery): void {
  for (let index = 1; index < bucket.records.length; index += 1) {
    const previous = bucket.records[index - 1];
    const current = bucket.records[index];
    if (previous.time === current.time) {
      assert.ok(
        compareIdBytes(previous.id, current.id) < 0,
        `bucket ${bucket.bucketId} is not in ID byte order`,
      );
    } else {
      assert.ok(
        previous.time < current.time,
        `bucket ${bucket.bucketId} is not in ascending time order`,
      );
    }
  }
}

interface Drained {
  readonly buckets: readonly BucketDelivery[];
  readonly records: readonly CollectedRecord[];
  readonly terminal: NextResult;
}

async function drainSession(
  session: CollectorSession,
  store: InMemoryCheckpointStore,
): Promise<Drained> {
  const buckets: BucketDelivery[] = [];
  const records: CollectedRecord[] = [];
  for (;;) {
    const next = await session.next();
    if (next.kind !== "bucket") {
      return { buckets, records, terminal: next };
    }
    assert.equal(next.bucket.snapshotToken, session.snapshotToken);
    assertBucketOrdering(next.bucket);
    const confirmed = await next.bucket.confirm();
    assert.equal(confirmed.confirmed, true);
    buckets.push(next.bucket);
    records.push(...next.bucket.records);
    const checkpoint = store.getCheckpoint();
    assert.ok(checkpoint !== null);
    assert.equal(
      checkpoint.confirmedThrough,
      next.bucket.interval.to,
      "confirm must persist the whole bucket watermark",
    );
  }
}

async function drainConfirmed(
  collector: IncrementalTimeCollector,
  store: InMemoryCheckpointStore,
): Promise<Drained> {
  return drainSession(await collector.start(), store);
}

function assertModelMatch(
  records: readonly CollectedRecord[],
  expected: readonly FakeRecord[],
): void {
  const actual = records.map((record) => ({
    id: record.id,
    time: record.time,
    content: record.content,
  }));
  const model = sortedModel(expected).map((record) => ({
    id: record.id,
    time: record.time,
    content: record.content,
  }));
  assert.deepEqual(actual, model);
}

function assertIntervalsPartition(
  buckets: readonly BucketDelivery[],
  from: bigint,
  to: bigint,
): void {
  let expected = from;
  for (const bucket of buckets) {
    assert.equal(
      bucket.interval.from,
      expected,
      "bucket intervals must be contiguous and non-overlapping",
    );
    assert.ok(bucket.interval.to >= bucket.interval.from);
    expected = bucket.interval.to + 1n;
  }
  assert.equal(expected - 1n, to);
}

function expectContractCode(
  error: unknown,
  code: string,
): boolean {
  return error instanceof RemoteContractError && error.code === code;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("splitTimeInterval is exact at the int64 extremes", () => {
  const [left, right] = splitTimeInterval(INT64_MIN, INT64_MAX);
  assert.deepEqual(left, { from: INT64_MIN, to: -1n });
  assert.deepEqual(right, { from: 0n, to: INT64_MAX });
  assert.equal(left.to + 1n, right.from);

  const [a, b] = splitTimeInterval(0n, 2n);
  assert.deepEqual(a, { from: 0n, to: 1n });
  assert.deepEqual(b, { from: 2n, to: 2n });
  const [c, d] = splitTimeInterval(-3n, 2n);
  assert.deepEqual(c, { from: -3n, to: -1n });
  assert.deepEqual(d, { from: 0n, to: 2n });
});

test("compareIdBytes uses UTF-8 byte order rather than UTF-16 order", () => {
  assert.ok(compareIdBytes("\u{1F600}", "\uE000") > 0);
  assert.ok(compareIdBytes("a", "aa") < 0);
  assert.equal(compareIdBytes("same", "same"), 0);
});

test("bisection covers sparse extreme-int64 times and matches the model", async () => {
  const data: readonly FakeRecord[] = [
    makeRecord("min", INT64_MIN),
    makeRecord("minus-one", -1n),
    makeRecord("zero", 0n),
    makeRecord("five", 5n),
    makeRecord("max", INT64_MAX),
  ];
  const remote = new FakeRemote({ k: 2, versions: [data] });
  const store = new InMemoryCheckpointStore();
  const collector = new IncrementalTimeCollector({
    remote,
    k: 2,
    store,
  });
  const drained = await drainConfirmed(collector, store);
  assert.equal(drained.terminal.kind, "done");
  assert.equal(drained.terminal.kind === "done" && drained.terminal.confirmedThrough, INT64_MAX);
  assertIntervalsPartition(drained.buckets, INT64_MIN, INT64_MAX);
  assertModelMatch(drained.records, data);
  const checkpoint = store.getCheckpoint();
  assert.ok(checkpoint !== null);
  assert.equal(checkpoint.confirmedThrough, INT64_MAX);
  assert.equal(checkpoint.pending.length, 0);
  for (const query of remote.rangeQueries) {
    assert.ok(query.from <= query.to);
    assert.ok(query.from >= INT64_MIN && query.to <= INT64_MAX);
  }
});

test("dense timestamp uses ID seek pages and preserves strict byte order", async () => {
  const ids: string[] = [];
  for (let index = 0; index < 50; index += 1) {
    ids.push(`id-${index.toString().padStart(3, "0")}`);
  }
  ids.push("\uE000", "\u{1F600}");
  const data = ids.map((id) => makeRecord(id, 42n, `content-${id}`));
  const remote = new FakeRemote({ k: 7, versions: [data], seed: 123 });
  const store = new InMemoryCheckpointStore();
  const collector = new IncrementalTimeCollector({
    remote,
    k: 7,
    store,
    from: 42n,
    to: 42n,
  });
  const drained = await drainConfirmed(collector, store);
  assert.equal(drained.terminal.kind, "done");
  assert.equal(drained.buckets.length, 1);
  assert.equal(drained.buckets[0].interval.from, 42n);
  assert.equal(drained.buckets[0].interval.to, 42n);
  assertModelMatch(drained.records, data);
  assert.ok(remote.seekQueries.length >= Math.ceil(data.length / 7));
  assert.equal(remote.seekQueries[0].cursor, null);
  for (let index = 1; index < remote.seekQueries.length; index += 1) {
    assert.notEqual(remote.seekQueries[index].cursor, null);
    assert.equal(remote.seekQueries[index].time, 42n);
  }
  assert.equal(store.getEvidence()[0].attempt, 1);
});

test("random fixed-snapshot run matches full ascending-time/ID model", async () => {
  const random = makeRandom(0xdecafbad);
  const data: FakeRecord[] = [];
  for (let index = 0; index < 180; index += 1) {
    const time = BigInt(Math.floor(random() * 41) - 20);
    data.push(makeRecord(`r-${index.toString().padStart(4, "0")}`, time, index));
  }
  const remote = new FakeRemote({ k: 5, versions: [data], seed: 99 });
  const store = new InMemoryCheckpointStore();
  const collector = new IncrementalTimeCollector({
    remote,
    k: 5,
    store,
    from: -20n,
    to: 20n,
  });
  const drained = await drainConfirmed(collector, store);
  assert.equal(drained.terminal.kind, "done");
  assertIntervalsPartition(drained.buckets, -20n, 20n);
  assertModelMatch(drained.records, data);
  assert.ok(remote.seekQueries.length > 0, "dense timestamps should require seek");
});

test("total <= K but a short page is rejected", async () => {
  const data = [makeRecord("a", 0n), makeRecord("b", 0n)];
  const remote = new FakeRemote({
    k: 5,
    versions: [data],
    rangeHook: (page) => ({ ...page, records: page.records.slice(0, 1) }),
  });
  const store = new InMemoryCheckpointStore();
  const session = await new IncrementalTimeCollector({
    remote,
    k: 5,
    store,
    from: 0n,
    to: 0n,
  }).start();
  await assert.rejects(
    session.next(),
    (error) => expectContractCode(error, "COUNT_TOTAL_MISMATCH"),
  );
});

test("a page with more records than total is rejected", async () => {
  const data = [makeRecord("a", 0n)];
  const remote = new FakeRemote({
    k: 5,
    versions: [data],
    rangeHook: (page) => ({
      total: page.total,
      records: [
        ...page.records,
        makeRecord("ghost", 0n),
      ],
    }),
  });
  const store = new InMemoryCheckpointStore();
  const session = await new IncrementalTimeCollector({
    remote,
    k: 5,
    store,
    from: 0n,
    to: 0n,
  }).start();
  await assert.rejects(
    session.next(),
    (error) => expectContractCode(error, "RECORD_COUNT_EXCEEDS_TOTAL"),
  );
});

test("a page with more than K records is rejected", async () => {
  const data = [0n, 1n, 2n, 3n, 4n].map((time, index) =>
    makeRecord(`r-${index}`, time),
  );
  const remote = new FakeRemote({
    k: 3,
    versions: [data],
    rangeHook: (page, context) => ({
      total: context.total,
      records: context.allRecords.slice(0, 4),
    }),
  });
  const store = new InMemoryCheckpointStore();
  const session = await new IncrementalTimeCollector({
    remote,
    k: 3,
    store,
    from: 0n,
    to: 4n,
  }).start();
  await assert.rejects(
    session.next(),
    (error) => expectContractCode(error, "RECORD_COUNT_EXCEEDS_K"),
  );
});

test("a range page returning a record outside the queried interval is rejected", async () => {
  const data = [makeRecord("inside", 0n), makeRecord("outside", 1n)];
  const remote = new FakeRemote({
    k: 10,
    versions: [data],
    rangeHook: (page, context) => {
      if (context.index === 0) {
        return {
          total: 1n,
          records: [makeRecord("outside", 1n)],
        };
      }
      return page;
    },
  });
  const store = new InMemoryCheckpointStore();
  const session = await new IncrementalTimeCollector({
    remote,
    k: 10,
    store,
    from: 0n,
    to: 0n,
  }).start();
  await assert.rejects(
    session.next(),
    (error) => expectContractCode(error, "RECORD_TIME_OUT_OF_RANGE"),
  );
});

test("seek pages that are not strictly increasing are rejected", async () => {
  const data = [0n, 1n, 2n, 3n, 4n].map((time, index) =>
    makeRecord(`s-${index}`, 0n, time),
  );
  const remote = new FakeRemote({
    k: 3,
    versions: [data],
    seekHook: (page, context) => {
      if (context.index === 0 && page.records.length >= 2) {
        return {
          records: [page.records[1], page.records[0], ...page.records.slice(2)],
        };
      }
      return page;
    },
  });
  const store = new InMemoryCheckpointStore();
  const session = await new IncrementalTimeCollector({
    remote,
    k: 3,
    store,
    from: 0n,
    to: 0n,
  }).start();
  await assert.rejects(
    session.next(),
    (error) => expectContractCode(error, "SEEK_NOT_STRICTLY_INCREASING"),
  );
});

test("seek cursor is exclusive, not inclusive", async () => {
  const data = [0n, 1n, 2n, 3n, 4n].map((time, index) =>
    makeRecord(`e-${index}`, 0n, time),
  );
  const remote = new FakeRemote({
    k: 2,
    versions: [data],
    seekHook: (page, context) => {
      if (context.index === 1 && context.cursor !== null) {
        return {
          records: [
            makeRecord(context.cursor, context.time, "cursor"),
            ...page.records.slice(0, Math.max(page.records.length - 1, 0)),
          ],
        };
      }
      return page;
    },
  });
  const store = new InMemoryCheckpointStore();
  const session = await new IncrementalTimeCollector({
    remote,
    k: 2,
    store,
    from: 0n,
    to: 0n,
  }).start();
  await assert.rejects(
    session.next(),
    (error) => expectContractCode(error, "SEEK_CURSOR_NOT_EXCLUSIVE"),
  );
});

test("a seek page at the wrong timestamp is rejected", async () => {
  const data = [0n, 1n, 2n, 3n, 4n].map((time, index) =>
    makeRecord(`t-${index}`, 0n, time),
  );
  const remote = new FakeRemote({
    k: 2,
    versions: [data],
    seekHook: (page, context) => {
      if (context.index === 0) {
        return {
          records: page.records.map((record, index) =>
            index === 0 ? makeRecord(record.id, 1n, record.content) : record,
          ),
        };
      }
      return page;
    },
  });
  const store = new InMemoryCheckpointStore();
  const session = await new IncrementalTimeCollector({
    remote,
    k: 2,
    store,
    from: 0n,
    to: 0n,
  }).start();
  await assert.rejects(
    session.next(),
    (error) => expectContractCode(error, "SEEK_TIME_MISMATCH"),
  );
});

test("seek enumeration must equal the range total", async () => {
  const data = [0n, 1n, 2n, 3n, 4n].map((time, index) =>
    makeRecord(`q-${index}`, 0n, time),
  );
  const remote = new FakeRemote({
    k: 2,
    versions: [data],
    seekHook: (page, context) => {
      if (context.index === 0) {
        return { records: page.records.slice(0, 1), hasMore: false };
      }
      return page;
    },
  });
  const store = new InMemoryCheckpointStore();
  const session = await new IncrementalTimeCollector({
    remote,
    k: 2,
    store,
    from: 0n,
    to: 0n,
  }).start();
  await assert.rejects(
    session.next(),
    (error) => expectContractCode(error, "SEEK_TOTAL_MISMATCH"),
  );
});

test("an empty seek page with hasMore=true is rejected", async () => {
  const data = [0n, 1n, 2n, 3n, 4n].map((time, index) =>
    makeRecord(`h-${index}`, 0n, time),
  );
  const remote = new FakeRemote({
    k: 2,
    versions: [data],
    seekHook: (page, context) => {
      if (context.index === 0) {
        return { records: [], hasMore: true };
      }
      return page;
    },
  });
  const store = new InMemoryCheckpointStore();
  const session = await new IncrementalTimeCollector({
    remote,
    k: 2,
    store,
    from: 0n,
    to: 0n,
  }).start();
  await assert.rejects(
    session.next(),
    (error) => expectContractCode(error, "SEEK_HAS_MORE_EMPTY_PAGE"),
  );
});

test("crash after delivery but before confirmation re-fetches the same snapshot and repeats", async () => {
  const data = [0n, 1n, 2n, 3n, 4n, 5n].map((time, index) =>
    makeRecord(`c-${index}`, time, `v-${index}`),
  );
  const remote = new FakeRemote({ k: 2, versions: [data] });
  const store = new InMemoryCheckpointStore();
  const collector = new IncrementalTimeCollector({
    remote,
    k: 2,
    store,
    from: 0n,
    to: 5n,
  });

  const first = await collector.start();
  const bucketA = await first.next();
  assert.equal(bucketA.kind, "bucket");
  if (bucketA.kind !== "bucket") return;
  assert.equal((await bucketA.bucket.confirm()).confirmed, true);

  const bucketB = await first.next();
  assert.equal(bucketB.kind, "bucket");
  if (bucketB.kind !== "bucket") return;
  assert.equal((await bucketB.bucket.confirm()).confirmed, true);

  const bucketC = await first.next();
  assert.equal(bucketC.kind, "bucket");
  if (bucketC.kind !== "bucket") return;
  const checkpointBeforeRecovery = store.getCheckpoint();
  assert.ok(checkpointBeforeRecovery !== null);
  assert.equal(checkpointBeforeRecovery.confirmedThrough, bucketB.bucket.interval.to);
  assert.deepEqual(checkpointBeforeRecovery.pending[0], bucketC.bucket.interval);
  assert.equal(checkpointBeforeRecovery.snapshotToken, first.snapshotToken);

  const second = await collector.start();
  assert.equal(second.snapshotToken, first.snapshotToken);
  const repeated = await second.next();
  assert.equal(repeated.kind, "bucket");
  if (repeated.kind !== "bucket") return;
  assert.deepEqual(
    repeated.bucket.records.map((record) => record.id),
    bucketC.bucket.records.map((record) => record.id),
  );
  assert.equal((await repeated.bucket.confirm()).confirmed, true);

  const confirmedRecords: CollectedRecord[] = [
    ...bucketA.bucket.records,
    ...bucketB.bucket.records,
    ...repeated.bucket.records,
  ];
  for (;;) {
    const next = await second.next();
    if (next.kind !== "bucket") {
      assert.equal(next.kind, "done");
      break;
    }
    assert.equal((await next.bucket.confirm()).confirmed, true);
    confirmedRecords.push(...next.bucket.records);
  }
  assertModelMatch(confirmedRecords, data);
  const evidence = store.getEvidence();
  const repeatedEvidence = evidence.filter(
    (entry) => entry.bucketId === bucketC.bucket.bucketId,
  );
  assert.ok(repeatedEvidence.length >= 2);
  assert.ok(
    repeatedEvidence.every((entry) => entry.snapshotToken === first.snapshotToken),
  );
});

test("expired checkpoint snapshot is retired and re-acquired for the same remaining range", async () => {
  const timeZero = makeRecord("z", 0n, "zero");
  const timeOne = makeRecord("one", 1n, "one");
  const sameOld = makeRecord("same", 2n, "old");
  const restOld = [3n, 4n, 5n].map((time) =>
    makeRecord(`r-${time}`, time, `old-${time}`),
  );
  const versionOne = [timeZero, timeOne, sameOld, ...restOld];
  const sameNew = makeRecord("same", 2n, "new");
  const restNew = [3n, 4n, 5n].map((time) =>
    makeRecord(`r-${time}`, time, `new-${time}`),
  );
  const versionTwo = [timeZero, timeOne, sameNew, ...restNew];
  const remote = new FakeRemote({ k: 2, versions: [versionOne, versionTwo] });
  const store = new InMemoryCheckpointStore();
  const collector = new IncrementalTimeCollector({
    remote,
    k: 2,
    store,
    from: 0n,
    to: 5n,
  });

  const first = await collector.start();
  const firstBucket = await first.next();
  assert.equal(firstBucket.kind, "bucket");
  if (firstBucket.kind !== "bucket") return;
  assert.equal((await firstBucket.bucket.confirm()).confirmed, true);
  const oldBucket = await first.next();
  assert.equal(oldBucket.kind, "bucket");
  if (oldBucket.kind !== "bucket") return;
  assert.equal(oldBucket.bucket.records[0].id, "same");
  assert.equal(oldBucket.bucket.records[0].content, "old");

  const checkpointBeforeExpiry = store.getCheckpoint();
  assert.ok(checkpointBeforeExpiry !== null);
  assert.equal(checkpointBeforeExpiry.confirmedThrough, 1n);
  assert.deepEqual(checkpointBeforeExpiry.pending[0], { from: 2n, to: 2n });

  remote.expireToken(first.snapshotToken);
  const resume = await collector.start();
  assert.notEqual(resume.snapshotToken, first.snapshotToken);
  assert.deepEqual(remote.acquireRequests.at(-1), { from: 2n, to: 5n });

  const resumed = await drainSession(resume, store);
  assert.equal(resumed.terminal.kind, "done");
  assert.ok(resumed.buckets.every((bucket) => bucket.snapshotToken === resume.snapshotToken));
  const expectedRemaining = [sameNew, ...restNew];
  assert.equal(resumed.records.length, expectedRemaining.length);
  assert.deepEqual(
    resumed.records.map((record) => ({
      id: record.id,
      time: record.time,
      content: record.content,
    })),
    sortedModel(expectedRemaining).map((record) => ({
      id: record.id,
      time: record.time,
      content: record.content,
    })),
  );

  const checkpoint = store.getCheckpoint();
  assert.ok(checkpoint !== null);
  assert.equal(checkpoint.confirmedThrough, 5n);
  assert.equal(checkpoint.retiredSnapshots.length, 1);
  assert.equal(checkpoint.retiredSnapshots[0].token, first.snapshotToken);
  assert.equal(checkpoint.retiredSnapshots[0].reason, "expired-on-resume");
  assert.deepEqual(checkpoint.retiredSnapshots[0].pending[0], {
    from: 2n,
    to: 2n,
  });

  const evidence = store.getEvidence();
  const oldEvidence = evidence.find(
    (entry) =>
      entry.snapshotToken === first.snapshotToken &&
      entry.records.some((record) => record.id === "same"),
  );
  const newEvidence = evidence.find(
    (entry) =>
      entry.snapshotToken === resume.snapshotToken &&
      entry.records.some((record) => record.id === "same"),
  );
  assert.ok(oldEvidence !== undefined);
  assert.ok(newEvidence !== undefined);
  assert.equal(
    oldEvidence.records.find((record) => record.id === "same")?.content,
    "old",
  );
  assert.equal(
    newEvidence.records.find((record) => record.id === "same")?.content,
    "new",
  );
});

test("token expiry during bisection stops without advancing the watermark", async () => {
  const data = [0n, 1n, 2n, 3n, 4n, 5n].map((time, index) =>
    makeRecord(`x-${index}`, time, time),
  );
  const store = new InMemoryCheckpointStore();
  let remote: FakeRemote;
  remote = new FakeRemote({
    k: 2,
    versions: [data],
    rangeHook: (page, context) => {
      if (context.index === 4) {
        remote.expireToken(context.token);
        throw new (class extends Error {
          code = "SNAPSHOT_EXPIRED";
        })("expired");
      }
      return page;
    },
  });
  const collector = new IncrementalTimeCollector({
    remote,
    k: 2,
    store,
    from: 0n,
    to: 5n,
  });
  const session = await collector.start();
  const firstBucket = await session.next();
  assert.equal(firstBucket.kind, "bucket");
  if (firstBucket.kind !== "bucket") return;
  assert.equal((await firstBucket.bucket.confirm()).confirmed, true);
  const secondBucket = await session.next();
  assert.equal(secondBucket.kind, "bucket");
  if (secondBucket.kind !== "bucket") return;
  assert.equal((await secondBucket.bucket.confirm()).confirmed, true);
  const result = await session.next();
  assert.equal(result.kind, "expired");
  const checkpoint = store.getCheckpoint();
  assert.ok(checkpoint !== null);
  assert.equal(checkpoint.confirmedThrough, 2n);
  assert.deepEqual(checkpoint.pending, [{ from: 3n, to: 5n }]);
  assert.equal(session.state, "expired");
});

test("a resumed snapshot may not reuse an earlier snapshot token", async () => {
  const data = [makeRecord("a", 0n), makeRecord("b", 1n)];
  const remote = new FakeRemote({ k: 10, versions: [data] });
  const store = new InMemoryCheckpointStore();
  const collector = new IncrementalTimeCollector({
    remote,
    k: 10,
    store,
    from: 0n,
    to: 1n,
  });
  const first = await collector.start();
  remote.expireToken(first.snapshotToken);
  remote.forceNextToken(first.snapshotToken);
  await assert.rejects(
    collector.start(),
    (error) => expectContractCode(error, "SNAPSHOT_TOKEN_REUSED"),
  );
  const checkpoint = store.getCheckpoint();
  assert.ok(checkpoint !== null);
  assert.equal(checkpoint.snapshotToken, first.snapshotToken);
  assert.equal(checkpoint.confirmedThrough, null);
});

test("explicit cancel before confirmation cannot advance the watermark", async () => {
  const data = [0n, 1n, 2n].map((time, index) =>
    makeRecord(`cc-${index}`, time, time),
  );
  const remote = new FakeRemote({ k: 2, versions: [data] });
  const store = new InMemoryCheckpointStore();
  const collector = new IncrementalTimeCollector({
    remote,
    k: 2,
    store,
    from: 0n,
    to: 2n,
  });
  const session = await collector.start();
  const next = await session.next();
  assert.equal(next.kind, "bucket");
  if (next.kind !== "bucket") return;
  assert.equal(session.cancel("operator"), "cancelled");
  const confirmation = await next.bucket.confirm();
  assert.equal(confirmation.confirmed, false);
  if (!confirmation.confirmed) {
    assert.equal(confirmation.reason, "cancelled");
  }
  const checkpoint = store.getCheckpoint();
  assert.ok(checkpoint !== null);
  assert.equal(checkpoint.confirmedThrough, null);
  assert.deepEqual(checkpoint.pending[0], next.bucket.interval);
  const stopped = await session.next();
  assert.equal(stopped.kind, "cancelled");
});

test("confirmation reserved before cancel is linearized first", async () => {
  const data = [0n, 1n, 2n].map((time, index) =>
    makeRecord(`cr-${index}`, time, time),
  );
  const remote = new FakeRemote({ k: 2, versions: [data] });
  const store = new InMemoryCheckpointStore();
  const collector = new IncrementalTimeCollector({
    remote,
    k: 2,
    store,
    from: 0n,
    to: 2n,
  });
  const session = await collector.start();
  const next = await session.next();
  assert.equal(next.kind, "bucket");
  if (next.kind !== "bucket") return;
  const confirmation = next.bucket.confirm();
  const cancelOutcome = session.cancel("too-late");
  assert.equal(cancelOutcome, "after-confirm");
  const result = await confirmation;
  assert.equal(result.confirmed, true);
  if (result.confirmed) {
    assert.equal(result.watermark, next.bucket.interval.to);
  }
  const checkpoint = store.getCheckpoint();
  assert.ok(checkpoint !== null);
  assert.equal(checkpoint.confirmedThrough, next.bucket.interval.to);
  const stopped = await session.next();
  assert.equal(stopped.kind, "cancelled");
});

test("AbortSignal cancellation is explicit and does not confirm a bucket", async () => {
  const data = [0n, 1n, 2n].map((time, index) =>
    makeRecord(`ab-${index}`, time, time),
  );
  const remote = new FakeRemote({ k: 2, versions: [data] });
  const store = new InMemoryCheckpointStore();
  const controller = new AbortController();
  const collector = new IncrementalTimeCollector({
    remote,
    k: 2,
    store,
    from: 0n,
    to: 2n,
    signal: controller.signal,
  });
  const session = await collector.start();
  const next = await session.next();
  assert.equal(next.kind, "bucket");
  if (next.kind !== "bucket") return;
  controller.abort();
  const confirmation = await next.bucket.confirm();
  assert.equal(confirmation.confirmed, false);
  const checkpoint = store.getCheckpoint();
  assert.ok(checkpoint !== null);
  assert.equal(checkpoint.confirmedThrough, null);
  const stopped = await session.next();
  assert.equal(stopped.kind, "cancelled");
  if (stopped.kind === "cancelled") {
    assert.equal(stopped.reason, "aborted");
  }
});

test("cancel while a range query is in flight discards temporary results", async () => {
  const data = [0n, 1n, 2n].map((time, index) =>
    makeRecord(`ip-${index}`, time, time),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const remote = new FakeRemote({
    k: 2,
    versions: [data],
    rangeHook: async (page) => {
      markStarted();
      await gate;
      return page;
    },
  });
  const store = new InMemoryCheckpointStore();
  const collector = new IncrementalTimeCollector({
    remote,
    k: 2,
    store,
    from: 0n,
    to: 2n,
  });
  const session = await collector.start();
  const nextPromise = session.next();
  await started;
  assert.equal(session.cancel("mid-query"), "cancelled");
  release();
  const result = await nextPromise;
  assert.equal(result.kind, "cancelled");
  const checkpoint = store.getCheckpoint();
  assert.ok(checkpoint !== null);
  assert.equal(checkpoint.confirmedThrough, null);
  assert.deepEqual(checkpoint.pending, [{ from: 0n, to: 2n }]);
});

class FlakyStore implements CheckpointStore {
  readonly inner = new InMemoryCheckpointStore();
  failNextSave = false;

  loadCheckpoint(): Checkpoint | null {
    return this.inner.loadCheckpoint();
  }

  saveCheckpoint(checkpoint: Checkpoint): void {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("storage unavailable");
    }
    this.inner.saveCheckpoint(checkpoint);
  }

  appendEvidence(evidence: DeliveryEvidence): void {
    this.inner.appendEvidence(evidence);
  }
}

test("a failed bucket confirmation retries the same bucket without skipping", async () => {
  const data = [0n, 1n, 2n, 3n, 4n].map((time, index) =>
    makeRecord(`sf-${index}`, time, time),
  );
  const remote = new FakeRemote({ k: 2, versions: [data] });
  const store = new FlakyStore();
  const collector = new IncrementalTimeCollector({
    remote,
    k: 2,
    store,
    from: 0n,
    to: 4n,
  });
  const session = await collector.start();
  const first = await session.next();
  assert.equal(first.kind, "bucket");
  if (first.kind !== "bucket") return;
  store.failNextSave = true;
  const failed = await first.bucket.confirm();
  assert.equal(failed.confirmed, false);
  if (!failed.confirmed) {
    assert.equal(failed.reason, "storage-failed");
  }
  const checkpoint = store.loadCheckpoint();
  assert.ok(checkpoint !== null);
  assert.equal(checkpoint.confirmedThrough, null);

  const repeated = await session.next();
  assert.equal(repeated.kind, "bucket");
  if (repeated.kind !== "bucket") return;
  assert.equal(repeated.bucket.bucketId, first.bucket.bucketId);
  assert.equal(repeated.bucket.attempt, 2);
  assert.equal(repeated.bucket.isRedelivery, true);
  assert.deepEqual(
    repeated.bucket.records.map((record) => record.id),
    first.bucket.records.map((record) => record.id),
  );
  assert.equal((await repeated.bucket.confirm()).confirmed, true);

  const records: CollectedRecord[] = [...repeated.bucket.records];
  for (;;) {
    const next = await session.next();
    if (next.kind !== "bucket") {
      assert.equal(next.kind, "done");
      break;
    }
    assert.equal((await next.bucket.confirm()).confirmed, true);
    records.push(...next.bucket.records);
  }
  assertModelMatch(records, data);
});
