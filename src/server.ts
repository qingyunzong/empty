import { BUCKET_COUNT, BucketEntry, Store } from "./store";
import { BucketDigest, HashFn, digestsFor, sha256 } from "./digest";

export class VersionMismatchError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number
  ) {
    super(`source version changed: expected ${expected}, actual ${actual}`);
    this.name = "VersionMismatchError";
  }
}

/**
 * Read side of the sync protocol. Every request is pinned to a source
 * version observed by the client; if the store has moved on, the request
 * is rejected with VersionMismatchError so the client retries the round.
 */
export class SyncServer {
  constructor(
    readonly store: Store,
    readonly hashFn: HashFn = sha256,
    readonly bucketCount: number = BUCKET_COUNT
  ) {}

  get version(): number {
    return this.store.version;
  }

  digests(expectedVersion: number): BucketDigest[] {
    this.assertVersion(expectedVersion);
    return digestsFor(this.store, this.hashFn, this.bucketCount);
  }

  bucketEntries(index: number, expectedVersion: number): BucketEntry[] {
    this.assertVersion(expectedVersion);
    return this.store.entriesInBucket(index, this.bucketCount).map((entry) =>
      entry.kind === "live" ? { kind: "live", key: entry.key, value: entry.value.slice() } : entry
    );
  }

  allLiveEntries(expectedVersion: number): Array<[number, Uint8Array]> {
    this.assertVersion(expectedVersion);
    return this.store.liveEntries().map(([key, value]) => [key, value.slice()]);
  }

  private assertVersion(expected: number): void {
    if (this.store.version !== expected) {
      throw new VersionMismatchError(expected, this.store.version);
    }
  }
}
