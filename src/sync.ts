import { BUCKET_COUNT, BucketEntry, Store } from "./store";
import { HashFn, digestsFor, sameDigest, sha256 } from "./digest";
import { SyncServer, VersionMismatchError } from "./server";

export interface SyncOptions {
  hashFn?: HashFn;
  bucketCount?: number;
  /**
   * When true, buckets whose digests match are still confirmed record by
   * record, byte by byte. This catches hash collisions that would otherwise
   * silently mask divergent content.
   */
  byteVerify?: boolean;
  /** How many times a round may be retried after the source version moved. */
  maxRetries?: number;
}

export interface SyncStats {
  rounds: number;
  retries: number;
  fetchedBuckets: number[];
  byteCheckedBuckets: number;
  byteMismatchedBuckets: number[];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Replace a destination bucket with the source's entries for that bucket. */
function replaceBucket(
  dest: Store,
  index: number,
  entries: BucketEntry[],
  bucketCount: number
): void {
  const remoteKeys = new Set(entries.map((entry) => entry.key));
  for (const local of dest.entriesInBucket(index, bucketCount)) {
    if (!remoteKeys.has(local.key)) dest.purge(local.key);
  }
  for (const entry of entries) dest.apply(entry);
}

/** Record-by-record, byte-by-byte confirmation of two sorted entry lists. */
export function entriesBytesEqual(a: BucketEntry[], b: BucketEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.kind !== right.kind || left.key !== right.key) return false;
    if (left.kind === "live" && right.kind === "live" && !bytesEqual(left.value, right.value)) {
      return false;
    }
  }
  return true;
}

/**
 * Reconcile `dest` with the source behind `server`. The whole round is
 * pinned to the source version observed at round start; any version drift
 * (reported by the server or caught by the end-of-round barrier) retries
 * the round from scratch.
 */
export function syncStore(dest: Store, server: SyncServer, options: SyncOptions = {}): SyncStats {
  const hashFn = options.hashFn ?? server.hashFn;
  const bucketCount = options.bucketCount ?? server.bucketCount;
  const byteVerify = options.byteVerify ?? false;
  const maxRetries = options.maxRetries ?? 8;
  const stats: SyncStats = {
    rounds: 0,
    retries: 0,
    fetchedBuckets: [],
    byteCheckedBuckets: 0,
    byteMismatchedBuckets: [],
  };

  for (let attempt = 0; ; attempt++) {
    try {
      stats.rounds++;
      const version = server.version;
      const remote = server.digests(version);
      const local = digestsFor(dest, hashFn, bucketCount);

      const differing: number[] = [];
      for (let index = 0; index < bucketCount; index++) {
        if (!sameDigest(remote[index]!, local[index]!)) differing.push(index);
      }

      // Only differing buckets are fetched; each fetched bucket's content is
      // replaced wholesale with the source's (extras purged, not just merged).
      for (const index of differing) {
        const entries = server.bucketEntries(index, version);
        replaceBucket(dest, index, entries, bucketCount);
      }
      stats.fetchedBuckets.push(...differing);

      if (byteVerify) {
        const skipped = new Set(differing);
        for (let index = 0; index < bucketCount; index++) {
          if (skipped.has(index)) continue;
          stats.byteCheckedBuckets++;
          const remoteEntries = server.bucketEntries(index, version);
          const localEntries = dest.entriesInBucket(index, bucketCount);
          if (!entriesBytesEqual(localEntries, remoteEntries)) {
            stats.byteMismatchedBuckets.push(index);
            replaceBucket(dest, index, remoteEntries, bucketCount);
          }
        }
      }

      // End-of-round barrier: the source must not have moved mid-round.
      if (server.version !== version) {
        throw new VersionMismatchError(version, server.version);
      }
      return stats;
    } catch (error) {
      if (error instanceof VersionMismatchError && attempt < maxRetries) {
        stats.retries++;
        continue;
      }
      throw error;
    }
  }
}

/** Final verification: compare the destination against the full source set. */
export function verifyFullSet(dest: Store, server: SyncServer): boolean {
  const remote = server.allLiveEntries(server.version);
  const local = dest.liveEntries();
  if (remote.length !== local.length) return false;
  for (let i = 0; i < remote.length; i++) {
    const [remoteKey, remoteValue] = remote[i]!;
    const [localKey, localValue] = local[i]!;
    if (remoteKey !== localKey || !bytesEqual(remoteValue, localValue)) return false;
  }
  return true;
}
