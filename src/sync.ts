import {
  BucketRecord,
  BucketSummary,
  Store,
  recordsEqual,
} from "./store.js";

/** Thrown by the server when a request's pinned version no longer matches. */
export class VersionChangedError extends Error {
  readonly pinnedVersion: number;
  readonly currentVersion: number;
  constructor(pinnedVersion: number, currentVersion: number) {
    super(
      `source version changed during round: pinned=${pinnedVersion} current=${currentVersion}`,
    );
    this.name = "VersionChangedError";
    this.pinnedVersion = pinnedVersion;
    this.currentVersion = currentVersion;
  }
}

/** Source side of the sync protocol. */
export class SyncServer {
  protected readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Checkpoint: summaries stamped with the version they were computed at. */
  getCheckpoint(): { version: number; summaries: BucketSummary[] } {
    return { version: this.store.version, summaries: this.store.summaries() };
  }

  /**
   * Bucket records, only if the caller's pinned version is still current.
   * Otherwise the round is aborted and must be retried against a fresh
   * checkpoint.
   */
  getBucketRecords(bucket: number, pinnedVersion: number): BucketRecord[] {
    if (pinnedVersion !== this.store.version) {
      throw new VersionChangedError(pinnedVersion, this.store.version);
    }
    return this.store.recordsInBucket(bucket);
  }
}

export interface SyncOptions {
  /** Max rounds before giving up (each version change forces a new round). */
  maxRounds?: number;
  /**
   * When a bucket's summary matches, still fetch it and confirm record by
   * record, byte by byte. Defeats digest collisions at the cost of traffic.
   */
  confirmBytes?: boolean;
}

export interface SyncStats {
  rounds: number;
  retries: number;
  bucketsFetched: number;
  recordsApplied: number;
  byteConfirmations: number;
  byteConfirmationMismatches: number;
}

/** Destination side: pulls only differing buckets, pinned to one version. */
export class SyncClient {
  private readonly local: Store;
  private readonly server: SyncServer;
  private readonly maxRounds: number;
  private readonly confirmBytes: boolean;

  constructor(local: Store, server: SyncServer, options: SyncOptions = {}) {
    this.local = local;
    this.server = server;
    this.maxRounds = options.maxRounds ?? 16;
    this.confirmBytes = options.confirmBytes ?? false;
  }

  sync(): SyncStats {
    const stats: SyncStats = {
      rounds: 0,
      retries: 0,
      bucketsFetched: 0,
      recordsApplied: 0,
      byteConfirmations: 0,
      byteConfirmationMismatches: 0,
    };

    while (stats.rounds < this.maxRounds) {
      stats.rounds++;
      const checkpoint = this.server.getCheckpoint();
      const localSummaries = this.local.summaries();
      try {
        for (let bucket = 0; bucket < this.local.bucketCount; bucket++) {
          const remote = checkpoint.summaries[bucket]!;
          const mine = localSummaries[bucket]!;
          if (remote.digest !== mine.digest || remote.count !== mine.count) {
            this.pullBucket(bucket, checkpoint.version, stats);
          } else if (this.confirmBytes) {
            this.confirmBucket(bucket, checkpoint.version, stats);
          }
        }
        return stats; // whole round completed against one pinned version
      } catch (err) {
        if (err instanceof VersionChangedError) {
          stats.retries++;
          continue; // retry the round with a fresh checkpoint
        }
        throw err;
      }
    }
    throw new Error(
      `sync did not converge within ${this.maxRounds} rounds (source keeps changing)`,
    );
  }

  private pullBucket(bucket: number, version: number, stats: SyncStats): void {
    const records = this.server.getBucketRecords(bucket, version);
    this.local.apply(records);
    stats.bucketsFetched++;
    stats.recordsApplied += records.length;
  }

  private confirmBucket(bucket: number, version: number, stats: SyncStats): void {
    const remoteRecords = this.server.getBucketRecords(bucket, version);
    stats.byteConfirmations++;
    const localRecords = this.local.recordsInBucket(bucket);
    if (!recordsEqual(remoteRecords, localRecords)) {
      // Summary said "equal" but bytes disagree: a digest collision.
      this.local.apply(remoteRecords);
      stats.byteConfirmationMismatches++;
      stats.recordsApplied += remoteRecords.length;
    }
  }
}
