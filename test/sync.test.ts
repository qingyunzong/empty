import { test } from "node:test";
import * as assert from "node:assert/strict";
import { BUCKET_COUNT, Store, bucketOf } from "../src/store";
import { HashFn, digestsFor } from "../src/digest";
import { SyncServer, VersionMismatchError } from "../src/server";
import { syncStore, verifyFullSet } from "../src/sync";

function valueOf(...bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

/** Weak 8-bit additive hash used to inject digest collisions on demand. */
const weakHash: HashFn = (data) => {
  let sum = 0;
  for (const byte of data) sum = (sum + byte) & 0xff;
  return Uint8Array.of(sum);
};

function fill(store: Store, count: number, base: number): void {
  for (let key = 0; key < count; key++) {
    store.set(key, valueOf((key + base) & 0xff, (key * 7 + base) & 0xff));
  }
}

test("bucket digests: only differing buckets are fetched", () => {
  const source = new Store();
  const dest = new Store();
  fill(source, 200, 3);
  const server = new SyncServer(source);

  // Initial full sync: every non-empty bucket differs from empty dest.
  const first = syncStore(dest, server);
  assert.ok(verifyFullSet(dest, server));
  assert.ok(first.fetchedBuckets.length > 0);

  // Diverge in exactly three buckets: one set, one overwrite, one delete.
  source.set(3, valueOf(9, 9, 9)); // bucket 3
  source.set(260, valueOf(1)); // bucket 260 % 16 = 4
  source.delete(5); // bucket 5
  const expected = [3, 4, 5].sort((a, b) => a - b);

  const second = syncStore(dest, server);
  assert.deepEqual([...second.fetchedBuckets].sort((a, b) => a - b), expected);
  assert.ok(verifyFullSet(dest, server), "final full-set comparison must pass");
});

test("tombstones are distinguishable from empty buckets and propagate deletes", () => {
  const source = new Store();
  const dest = new Store();
  source.set(8, valueOf(1, 2, 3));
  const server = new SyncServer(source);
  syncStore(dest, server);
  assert.ok(dest.has(8));

  source.delete(8); // leaves a tombstone in bucket 8
  const digests = digestsFor(source, server.hashFn);
  const tombstoneBucket = digests[8]!;
  const emptyBucket = digests[9]!; // never touched

  assert.equal(tombstoneBucket.live, 0);
  assert.equal(tombstoneBucket.tombstones, 1);
  assert.equal(emptyBucket.live, 0);
  assert.equal(emptyBucket.tombstones, 0);
  assert.notEqual(
    tombstoneBucket.hash,
    emptyBucket.hash,
    "tombstone-only bucket must differ from a truly empty bucket"
  );

  syncStore(dest, server);
  assert.ok(!dest.has(8), "delete must propagate");
  // Dest now carries the same tombstone, so its bucket 8 digest matches the
  // source's and still differs from an empty bucket.
  const destDigests = digestsFor(dest, server.hashFn);
  assert.equal(destDigests[8]!.hash, tombstoneBucket.hash);
  assert.notEqual(destDigests[8]!.hash, destDigests[9]!.hash);
  assert.ok(verifyFullSet(dest, server));
});

test("version pinned round: mid-round mutation triggers retry", () => {
  const source = new Store();
  const dest = new Store();
  fill(source, 64, 11);

  class MutatingServer extends SyncServer {
    private mutated = false;
    override digests(expectedVersion: number) {
      const result = super.digests(expectedVersion);
      if (!this.mutated) {
        this.mutated = true;
        // Source moves on right after serving digests: the next pinned
        // request must be rejected and the round retried.
        this.store.set(1000, valueOf(7, 7));
      }
      return result;
    }
  }
  const server = new MutatingServer(source);
  const stats = syncStore(dest, server);

  assert.equal(stats.retries, 1);
  assert.equal(stats.rounds, 2);
  assert.ok(dest.has(1000), "the mid-round write must be picked up by the retry");
  assert.ok(verifyFullSet(dest, server));
});

test("version pinned round: end-of-round barrier catches late mutation", () => {
  const source = new Store();
  const dest = new Store();
  fill(source, 32, 5);

  class LateMutatingServer extends SyncServer {
    private served = 0;
    override bucketEntries(index: number, expectedVersion: number) {
      const entries = super.bucketEntries(index, expectedVersion);
      this.served++;
      // Mutate after the last bucket fetch of the first round, so every
      // pinned request succeeds and only the barrier can catch the drift.
      if (this.served === BUCKET_COUNT) {
        this.store.set(2000, valueOf(3));
      }
      return entries;
    }
  }
  const server = new LateMutatingServer(source);
  const stats = syncStore(dest, server);

  assert.ok(stats.retries >= 1, "barrier must force at least one retry");
  assert.ok(dest.has(2000));
  assert.ok(verifyFullSet(dest, server));
});

test("version pinned round: retries are bounded", () => {
  const source = new Store();
  const dest = new Store();
  source.set(1, valueOf(1));

  class AlwaysMutatingServer extends SyncServer {
    override digests(expectedVersion: number) {
      const result = super.digests(expectedVersion);
      this.store.set(1, valueOf(Math.floor(Math.random() * 255)));
      return result;
    }
  }
  const server = new AlwaysMutatingServer(source);
  assert.throws(() => syncStore(dest, server, { maxRetries: 3 }), VersionMismatchError);
});

test("injected collision: per-record byte confirmation unmasks divergence", () => {
  const source = new Store();
  const dest = new Store();
  // Same bucket, same length, equal byte-sum: the weak hash collides.
  source.set(1, valueOf(1, 2));
  dest.set(1, valueOf(2, 1));
  const server = new SyncServer(source, weakHash);

  const remoteDigest = digestsFor(source, weakHash)[bucketOf(1)]!;
  const localDigest = digestsFor(dest, weakHash)[bucketOf(1)]!;
  assert.equal(remoteDigest.hash, localDigest.hash, "collision must be injected");

  // Without byte confirmation the collision silently masks the difference.
  const blind = syncStore(dest, server, { hashFn: weakHash });
  assert.deepEqual(blind.fetchedBuckets, []);
  assert.ok(!verifyFullSet(dest, server), "collision hides divergence without byte verify");

  // With byte confirmation the bucket is checked record by record and fixed.
  const careful = syncStore(dest, server, { hashFn: weakHash, byteVerify: true });
  assert.deepEqual(careful.byteMismatchedBuckets, [bucketOf(1)]);
  assert.deepEqual([...dest.get(1)!], [1, 2]);
  assert.ok(verifyFullSet(dest, server));
});

test("final comparison against the full set after randomized divergence", () => {
  // Deterministic LCG so the test is reproducible.
  let state = 0x2f6e2b1;
  const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff);

  const source = new Store();
  const dest = new Store();
  for (let i = 0; i < 500; i++) {
    const key = next() % 300;
    if (next() % 4 === 0) source.delete(key);
    else source.set(key, valueOf(next() & 0xff, next() & 0xff, next() & 0xff));
  }
  // Dest sees a different partial history.
  for (let i = 0; i < 200; i++) {
    const key = next() % 300;
    if (next() % 3 === 0) dest.delete(key);
    else dest.set(key, valueOf(next() & 0xff));
  }

  const server = new SyncServer(source);
  const stats = syncStore(dest, server);
  assert.ok(stats.fetchedBuckets.length > 0);
  assert.ok(verifyFullSet(dest, server), "dest must equal the full source set");

  // Per-bucket digests must also have converged (tombstones included).
  const remoteDigests = digestsFor(source, server.hashFn);
  const localDigests = digestsFor(dest, server.hashFn);
  for (let index = 0; index < BUCKET_COUNT; index++) {
    assert.equal(localDigests[index]!.hash, remoteDigests[index]!.hash, `bucket ${index}`);
  }
});
