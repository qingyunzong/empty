import test from "node:test";
import assert from "node:assert/strict";
import { constantDigest } from "../src/hash.js";
import {
  EMPTY_BUCKET_DIGEST,
  Store,
  bytesEqual,
} from "../src/store.js";
import { SyncClient, SyncServer, SyncStats } from "../src/sync.js";

const encoder = new TextEncoder();
const val = (s: string): Uint8Array => encoder.encode(s);

const BUCKETS = 16;
const KEY_SPACE = 1024;

/** Final full-set comparison: live entries byte-by-byte + tombstone sets. */
function assertStoresEqual(expected: Store, actual: Store): void {
  const expectedLive = expected.liveEntries();
  const actualLive = actual.liveEntries();
  assert.equal(
    actualLive.size,
    expectedLive.size,
    `live set size differs: ${actualLive.size} vs ${expectedLive.size}`,
  );
  for (const [key, expectedValue] of expectedLive) {
    const actualValue = actualLive.get(key);
    assert.ok(actualValue !== undefined, `key ${key} missing on destination`);
    assert.ok(
      bytesEqual(actualValue, expectedValue),
      `key ${key} value bytes differ`,
    );
  }
  assert.deepEqual(
    [...actual.tombstones()].sort((a, b) => a - b),
    [...expected.tombstones()].sort((a, b) => a - b),
    "tombstone sets differ",
  );
}

test("墓碑桶与空桶的摘要不同", () => {
  const withTombstone = new Store(BUCKETS, KEY_SPACE);
  withTombstone.set(1, val("x"));
  withTombstone.delete(1);

  const empty = new Store(BUCKETS, KEY_SPACE);

  const tombSummary = withTombstone.summaries()[0]!;
  const emptySummary = empty.summaries()[0]!;

  assert.equal(tombSummary.count, 1, "tombstone still counts as an entry");
  assert.equal(emptySummary.count, 0);
  assert.equal(emptySummary.digest, EMPTY_BUCKET_DIGEST);
  assert.notEqual(
    tombSummary.digest,
    emptySummary.digest,
    "deleted bucket must not look like a never-used bucket",
  );
});

test("增量同步只请求摘要不同的桶，最终全量一致", () => {
  const source = new Store(BUCKETS, KEY_SPACE);
  for (let key = 0; key < 100; key++) source.set(key, val(`v${key}`));

  const dest = new Store(BUCKETS, KEY_SPACE);
  const stats = new SyncClient(dest, new SyncServer(source)).sync();

  // keySpace 1024 / 16 buckets = 64 keys per bucket; keys 0..99 span buckets 0,1
  assert.equal(stats.bucketsFetched, 2, "only buckets 0 and 1 differ");
  assertStoresEqual(source, dest);

  // Touch exactly one key in bucket 3 (keys 192..255) and one in bucket 7.
  source.set(200, val("changed"));
  source.set(500, val("changed"));
  const stats2 = new SyncClient(dest, new SyncServer(source)).sync();
  assert.equal(stats2.bucketsFetched, 2, "second round only pulls 2 buckets");
  assertStoresEqual(source, dest);
});

test("删除通过墓碑传播，且墓碑集合一致", () => {
  const source = new Store(BUCKETS, KEY_SPACE);
  for (let key = 0; key < 50; key++) source.set(key, val(`v${key}`));
  const dest = new Store(BUCKETS, KEY_SPACE);
  new SyncClient(dest, new SyncServer(source)).sync();
  assertStoresEqual(source, dest);

  for (const key of [3, 17, 42]) source.delete(key);
  const stats = new SyncClient(dest, new SyncServer(source)).sync();
  assert.equal(stats.bucketsFetched, 1, "all deletes landed in bucket 0");

  assert.equal(dest.get(3), undefined);
  assert.equal(dest.get(17), undefined);
  assert.equal(dest.get(42), undefined);
  assert.ok(dest.tombstones().has(3), "tombstone replicated, not just absent");
  assertStoresEqual(source, dest);
});

test("同步全程绑定源版本：源变化则重试该轮并最终收敛", () => {
  const source = new Store(BUCKETS, KEY_SPACE);
  for (let key = 0; key < 200; key++) source.set(key, val(`v${key}`));
  const dest = new Store(BUCKETS, KEY_SPACE);

  // Server that mutates the source in the middle of the first round.
  class MutatingServer extends SyncServer {
    private mutated = false;
    override getBucketRecords(bucket: number, pinnedVersion: number) {
      if (!this.mutated) {
        this.mutated = true;
        source.set(999, val("late-write")); // bumps source version
      }
      return super.getBucketRecords(bucket, pinnedVersion);
    }
  }

  const stats: SyncStats = new SyncClient(dest, new MutatingServer(source)).sync();
  assert.ok(stats.retries >= 1, "version change must force a round retry");
  assert.ok(stats.rounds >= 2);
  assert.equal(dest.get(999) !== undefined, true, "late write replicated too");
  assertStoresEqual(source, dest);
});

test("注入摘要碰撞：不确认则漏同步，逐条字节确认后全量一致", () => {
  const collide = constantDigest(0x42);

  // Same keys, different values -> identical summaries under the colliding digest.
  const source = new Store(BUCKETS, KEY_SPACE, collide);
  const dest = new Store(BUCKETS, KEY_SPACE, collide);
  for (let key = 0; key < 10; key++) {
    source.set(key, val(`source-${key}`));
    dest.set(key, val(`dest---${key}`));
  }
  assert.deepEqual(source.summaries(), dest.summaries(), "collision injected");

  // Naive sync trusts the summaries and silently diverges.
  const naive = new SyncClient(dest, new SyncServer(source)).sync();
  assert.equal(naive.bucketsFetched, 0);
  assert.notDeepEqual(
    [...dest.liveEntries()].map(([k, v]) => [k, Array.from(v)]),
    [...source.liveEntries()].map(([k, v]) => [k, Array.from(v)]),
    "without byte confirmation the collision hides the difference",
  );

  // Byte-by-byte confirmation detects the mismatch and repairs it.
  const stats = new SyncClient(dest, new SyncServer(source), {
    confirmBytes: true,
  }).sync();
  assert.equal(stats.byteConfirmations, BUCKETS);
  assert.equal(stats.byteConfirmationMismatches, 1, "bucket 0 collided");
  assertStoresEqual(source, dest);
});
