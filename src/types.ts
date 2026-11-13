export type Clock = () => number;

export interface OwnershipRecord {
  partitionId: string;
  ownerId: string;
  epoch: number;
  etag: string;
  leaseExpiresAt: number;
  acquiredAt: number;
  updatedAt: number;
}

export interface OwnershipLease {
  partitionId: string;
  ownerId: string;
  epoch: number;
  etag: string;
  leaseExpiresAt: number;
  preempted?: boolean;
  previousEpoch?: number;
}

export interface CheckpointRecord {
  partitionId: string;
  sequenceNumber: number;
  epoch: number;
  ownerId: string;
  etag: string;
  updatedAt: number;
}

export interface Batch<T = unknown> {
  partitionId?: string;
  epoch?: number;
  etag?: string;
  sequenceNumber?: number;
  offset?: number;
  checkpoint?: number;
  watermark?: number;
  events?: T[];
  data?: T;
  [key: string]: unknown;
}

export type AcquireFailureReason =
  | "lease-active"
  | "etag-mismatch"
  | "partition-mismatch"
  | "storage-error";

export interface AcquireOwnershipRequest {
  partitionId: string;
  ownerId: string;
  now?: number;
  leaseDurationMs?: number;
  preempt?: boolean;
  /**
   * Conditional claim token. A string requires the current ownership row to
   * have that ETag; null requires that no ownership row exists.
   */
  expectedEtag?: string | null;
  epoch?: number;
}

export interface AcquireOwnershipResult {
  acquired: boolean;
  record?: OwnershipRecord;
  previous?: OwnershipRecord;
  preempted: boolean;
  reason?: AcquireFailureReason;
  error?: Error;
}

export interface RenewOwnershipRequest {
  partitionId: string;
  ownerId: string;
  epoch: number;
  etag: string;
  now?: number;
  leaseDurationMs?: number;
}

export type RenewFailureReason =
  | "stale-epoch"
  | "stale-ownership"
  | "not-owned"
  | "storage-error";

export interface RenewOwnershipResult {
  renewed: boolean;
  record?: OwnershipRecord;
  reason?: RenewFailureReason;
  error?: Error;
}

export interface ReleaseOwnershipRequest {
  partitionId: string;
  ownerId: string;
  epoch: number;
  etag: string;
  now?: number;
}

export interface ReleaseOwnershipResult {
  released: boolean;
  reason?: RenewFailureReason;
  error?: Error;
}

export const CommitFailureReason = {
  StaleEpoch: "stale-epoch",
  StaleOwnership: "stale-ownership",
  LeaseLost: "lease-lost",
  NotOwned: "not-owned",
  CheckpointConflict: "checkpoint-conflict",
  CheckpointRegression: "checkpoint-regression",
  StorageError: "storage-error",
} as const;

export type CommitFailureReason =
  (typeof CommitFailureReason)[keyof typeof CommitFailureReason];

export interface CommitCheckpointRequest {
  partitionId: string;
  ownerId: string;
  epoch: number;
  ownershipEtag: string;
  sequenceNumber: number;
  /**
   * Checkpoint CAS token. undefined skips the CAS check, null expects no
   * checkpoint yet, and a string expects the current checkpoint ETag.
   */
  expectedCheckpointEtag?: string | null;
  now?: number;
}

export interface CommitCheckpointResult {
  committed: boolean;
  checkpoint?: CheckpointRecord;
  previous?: CheckpointRecord;
  reason?: CommitFailureReason;
  error?: Error;
}

export interface OwnershipStore {
  getOwnership(partitionId: string): Promise<OwnershipRecord | undefined>;
  tryAcquireOwnership(
    request: AcquireOwnershipRequest,
  ): Promise<AcquireOwnershipResult>;
  renewOwnership(
    request: RenewOwnershipRequest,
  ): Promise<RenewOwnershipResult>;
  releaseOwnership(
    request: ReleaseOwnershipRequest,
  ): Promise<ReleaseOwnershipResult>;
}

export interface CheckpointStore {
  getCheckpoint(partitionId: string): Promise<CheckpointRecord | undefined>;
  commitCheckpoint(
    request: CommitCheckpointRequest,
  ): Promise<CommitCheckpointResult>;
}

export interface PartitionStore extends OwnershipStore, CheckpointStore {}

export type BatchHandler<T = unknown> = (
  batch: Batch<T>,
  ownership: unknown,
) => void | Promise<void>;

export type BatchStopReason =
  | "lease-lost"
  | "preempted"
  | "stale-epoch"
  | "stale-ownership"
  | "checkpoint-conflict"
  | "checkpoint-regression"
  | "not-owned"
  | "stopped"
  | "storage-error";

export interface BatchProcessResult {
  /** True when the result corresponds to a batch pulled from the receiver. */
  received?: boolean;
  processed: boolean;
  committed: boolean;
  checkpoint?: CheckpointRecord;
  reason?: BatchStopReason;
  error?: Error;
}

export type CollectorStopReason =
  | BatchStopReason
  | "source-exhausted"
  | "max-batches"
  | "error";

export interface CollectorResult {
  batchesReceived: number;
  batchesProcessed: number;
  batchesCommitted: number;
  checkpoint: number;
  stopReason: CollectorStopReason;
  error?: Error;
}

export interface OwnershipSnapshot {
  ownership: OwnershipRecord[];
  checkpoints: CheckpointRecord[];
}

export type StoreOperationName =
  | "acquire"
  | "renew"
  | "release"
  | "commit";

export interface StoreOperation {
  operation: StoreOperationName;
  request: unknown;
  startedAt: number;
  result?: unknown;
  error?: Error;
}
