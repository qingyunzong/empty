export const INT64_MIN = -(1n << 63n);
export const INT64_MAX = (1n << 63n) - 1n;

export type MaybePromise<T> = T | Promise<T>;

/**
 * Integers may arrive as bigint, safe JS numbers, or decimal strings.
 * The collector normalizes all of them to bigint before using them.
 */
export type IntegerInput = bigint | number | string;

export interface Interval {
  readonly from: bigint;
  readonly to: bigint;
}

export interface RemoteRecord {
  readonly id: string;
  readonly time: IntegerInput;
  readonly content?: unknown;
}

export interface CollectedRecord {
  readonly id: string;
  readonly time: bigint;
  readonly content: unknown;
}

/**
 * A page of the public-time-index query. `total` describes the whole closed
 * interval, not just this page. When total <= K the page must contain every
 * record in the interval.
 */
export interface RangePage {
  readonly total: IntegerInput;
  readonly records: readonly RemoteRecord[];
}

/**
 * A page of the ID-seek query for one exact timestamp. IDs in a page must be
 * strictly greater than `afterId` and strictly increasing in UTF-8 byte order.
 */
export interface SeekPage {
  readonly records: readonly RemoteRecord[];
  readonly hasMore?: boolean;
}

export interface SnapshotRequest {
  readonly from: bigint;
  readonly to: bigint;
}

export interface Snapshot {
  readonly token: string;
}

/**
 * Remote operations injected by the host. Every call that reads data must
 * carry the token, and implementations should throw SnapshotExpiredError (or
 * an error with code SNAPSHOT_EXPIRED) when the token is no longer valid.
 */
export interface SnapshotRemote {
  acquireSnapshot(range: SnapshotRequest): MaybePromise<Snapshot>;
  queryRange(
    from: bigint,
    to: bigint,
    snapshotToken: string,
  ): MaybePromise<RangePage>;
  seekById(
    time: bigint,
    afterId: string | null,
    snapshotToken: string,
  ): MaybePromise<SeekPage>;
}

export interface RetiredSnapshot {
  readonly token: string;
  readonly generation: number;
  readonly reason: string;
  readonly pending: readonly Interval[];
}

/**
 * Durable state. It intentionally contains intervals but never temporary
 * fetched records: unconfirmed fetch results are safe to discard on recovery.
 */
export interface Checkpoint {
  readonly version: 1;
  readonly streamId: string;
  readonly k: number;
  readonly scan: Interval;
  readonly confirmedThrough: bigint | null;
  readonly snapshotToken: string;
  readonly snapshotGeneration: number;
  readonly snapshotRange: Interval;
  readonly pending: readonly Interval[];
  readonly retiredSnapshots: readonly RetiredSnapshot[];
}

export interface DeliveryEvidence {
  readonly deliveryId: string;
  readonly bucketId: string;
  readonly snapshotToken: string;
  readonly snapshotGeneration: number;
  readonly interval: Interval;
  readonly attempt: number;
  readonly records: readonly CollectedRecord[];
}

/**
 * Storage is injected so the host can make checkpoint and evidence writes
 * durable. saveCheckpoint should be atomic. appendEvidence is append-only:
 * old snapshot evidence must remain readable after a new snapshot is acquired.
 */
export interface CheckpointStore {
  loadCheckpoint(): MaybePromise<Checkpoint | null>;
  saveCheckpoint(checkpoint: Checkpoint): MaybePromise<void>;
  appendEvidence(evidence: DeliveryEvidence): MaybePromise<void>;
}

export interface CollectorOptions {
  readonly remote: SnapshotRemote;
  /** Maximum page size. Must be a positive safe integer. */
  readonly k: number;
  readonly store: CheckpointStore;
  /** Initial scan lower bound. Defaults to INT64_MIN. */
  readonly from?: IntegerInput;
  /** Initial scan upper bound. Defaults to INT64_MAX. */
  readonly to?: IntegerInput;
  readonly streamId?: string;
  readonly signal?: AbortSignal;
}

export interface BucketDelivery {
  readonly kind: "bucket";
  readonly bucketId: string;
  readonly snapshotToken: string;
  readonly snapshotGeneration: number;
  readonly interval: Interval;
  readonly records: readonly CollectedRecord[];
  readonly attempt: number;
  readonly isRedelivery: boolean;
  confirm(): Promise<ConfirmResult>;
}

export type ConfirmResult =
  | {
      readonly confirmed: true;
      readonly bucketId: string;
      readonly watermark: bigint;
    }
  | {
      readonly confirmed: false;
      readonly bucketId: string;
      readonly reason: "cancelled" | "stale" | "storage-failed";
      readonly error?: unknown;
    };

export type NextResult =
  | { readonly kind: "bucket"; readonly bucket: BucketDelivery }
  | { readonly kind: "done"; readonly confirmedThrough: bigint }
  | {
      readonly kind: "expired";
      readonly snapshotToken: string;
      readonly checkpoint: Checkpoint;
    }
  | {
      readonly kind: "cancelled";
      readonly reason: string;
      readonly checkpoint: Checkpoint;
    };

export type CancelOutcome =
  | "cancelled"
  | "already-cancelled"
  | "after-confirm"
  | "finished";

export class RemoteContractError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RemoteContractError";
    this.code = code;
    this.details = details;
  }
}

export class CheckpointError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
    this.details = details;
  }
}

export class SnapshotExpiredError extends Error {
  readonly code = "SNAPSHOT_EXPIRED";
  readonly snapshotToken: string;

  constructor(snapshotToken: string) {
    super(`snapshot token expired: ${snapshotToken}`);
    this.name = "SnapshotExpiredError";
    this.snapshotToken = snapshotToken;
  }
}

export function isSnapshotExpired(error: unknown): boolean {
  if (error instanceof SnapshotExpiredError) {
    return true;
  }
  if (typeof error === "string") {
    return error === "SNAPSHOT_EXPIRED";
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; name?: unknown };
    return (
      candidate.code === "SNAPSHOT_EXPIRED" ||
      candidate.name === "SnapshotExpiredError"
    );
  }
  return false;
}
