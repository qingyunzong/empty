import {
  CheckpointConflictError,
  CheckpointRegressionError,
  CheckpointRejectedError,
  LeaseLostError,
  LeaseNotHeldError,
  OwnershipConflictError,
  OwnershipError,
  PreemptedError,
  StaleOwnershipError,
} from "./errors.ts";
import { EpochReceiver } from "./epoch-receiver.ts";
import type { BatchSource } from "./epoch-receiver.ts";
import type {
  AcquireOwnershipRequest,
  AcquireOwnershipResult,
  Batch,
  BatchHandler,
  BatchProcessResult,
  CheckpointRecord,
  Clock,
  CommitCheckpointResult,
  CommitFailureReason,
  OwnershipLease,
  OwnershipRecord,
  PartitionStore,
  ReleaseOwnershipResult,
  RenewOwnershipResult,
} from "./types.ts";
import { CommitFailureReason as CommitReason } from "./types.ts";

export interface PartitionOwnershipOptions {
  store: PartitionStore;
  partitionId: string;
  workerId?: string;
  ownerId?: string;
  leaseDurationMs?: number;
  now?: Clock;
  /** Watermark used before the partition has any checkpoint. */
  initialCheckpoint?: number;
}

export interface AcquireOptions {
  leaseDurationMs?: number;
  now?: number;
  preempt?: boolean;
  expectedEtag?: string | null;
  epoch?: number;
}

export interface RenewOptions {
  leaseDurationMs?: number;
  now?: number;
}

export interface ReleaseOptions {
  now?: number;
}

export interface CommitOptions {
  now?: number;
  /**
   * When true (default), a stale epoch / ownership token is rejected before
   * any checkpoint call. Set to false to let the store make the final decision.
   */
  validateToken?: boolean;
}

export interface ProcessBatchOptions {
  throwOnReject?: boolean;
  now?: number;
}

export interface CreateReceiverOptions<T = unknown> {
  source?: BatchSource<T>;
  batchSource?: BatchSource<T>;
  batches?: Iterable<Batch<T>> | AsyncIterable<Batch<T>>;
}

function isPartitionStore(value: unknown): value is PartitionStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "tryAcquireOwnership" in value &&
    "commitCheckpoint" in value
  );
}

function cloneLease(lease: OwnershipLease): OwnershipLease {
  return { ...lease };
}

function sequenceFromBatch(batch: Batch<unknown>): number {
  const candidates = [
    batch.sequenceNumber,
    batch.offset,
    batch.checkpoint,
    batch.watermark,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  throw new TypeError(
    "batch has no sequenceNumber/offset/checkpoint watermark",
  );
}

/**
 * Coordinates one worker's ownership lease with its epoch receiver and
 * checkpoint writes.
 *
 * Invariants:
 * - an epoch/ETag pair is immutable for the lifetime of a lease;
 * - a successful preemption creates the next epoch and a new ownership ETag;
 * - a checkpoint is only written while the current ownership row still matches
 *   both the batch epoch and the ownership ETag;
 * - a failed lease renewal freezes the checkpoint immediately, while allowing
 *   one already-received batch to be processed to its boundary.
 */
export class PartitionOwnership {
  readonly partitionId: string;
  readonly workerId: string;
  readonly store: PartitionStore;
  readonly leaseDurationMs: number;
  readonly initialCheckpoint: number;

  readonly #now: Clock;
  #lease?: OwnershipLease;
  #checkpoint?: CheckpointRecord;
  #checkpointEtag: string | null = null;
  #leaseLost = false;
  #preempted = false;
  #stopped = false;
  #processedAfterLeaseLoss = false;
  #lastRenewFailure?: RenewOwnershipResult;
  #lastCommitFailure?: CommitCheckpointResult;
  #lastCommitError?: CheckpointRejectedError;

  constructor(options: PartitionOwnershipOptions);
  constructor(
    store: PartitionStore,
    workerId: string,
    partitionId: string,
    options?: Omit<
      PartitionOwnershipOptions,
      "store" | "workerId" | "partitionId"
    >,
  );
  constructor(
    first: PartitionOwnershipOptions | PartitionStore,
    second?: string,
    third?: string,
    fourth: Omit<
      PartitionOwnershipOptions,
      "store" | "workerId" | "partitionId"
    > = {},
  ) {
    if (isPartitionStore(first)) {
      if (second === undefined || third === undefined) {
        throw new TypeError("workerId and partitionId are required");
      }
      this.store = first;
      this.workerId = second;
      this.partitionId = third;
      this.leaseDurationMs = fourth.leaseDurationMs ?? 30_000;
      this.#now = fourth.now ?? Date.now;
      this.initialCheckpoint = fourth.initialCheckpoint ?? -1;
    } else {
      this.store = first.store;
      this.workerId = first.workerId ?? first.ownerId ?? "worker";
      this.partitionId = first.partitionId;
      this.leaseDurationMs = first.leaseDurationMs ?? 30_000;
      this.#now = first.now ?? Date.now;
      this.initialCheckpoint = first.initialCheckpoint ?? -1;
    }
  }

  get ownerId(): string {
    return this.workerId;
  }

  get epoch(): number | undefined {
    return this.#lease?.epoch;
  }

  get etag(): string | undefined {
    return this.#lease?.etag;
  }

  get lease(): OwnershipLease | undefined {
    return this.#lease === undefined ? undefined : cloneLease(this.#lease);
  }

  get leaseExpiresAt(): number | undefined {
    return this.#lease?.leaseExpiresAt;
  }

  get leaseLost(): boolean {
    return this.#leaseLost;
  }

  get isLeaseLost(): boolean {
    return this.#leaseLost;
  }

  get renewalFailed(): boolean {
    return this.#leaseLost;
  }

  get preempted(): boolean {
    return this.#preempted;
  }

  get isPreempted(): boolean {
    return this.#preempted;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get isStopped(): boolean {
    return this.#stopped;
  }

  get checkpoint(): number {
    return this.#checkpoint?.sequenceNumber ?? this.initialCheckpoint;
  }

  get checkpointSequence(): number {
    return this.checkpoint;
  }

  get watermark(): number {
    return this.checkpoint;
  }

  get lastCommitError(): CheckpointRejectedError | undefined {
    return this.#lastCommitError;
  }

  async getCheckpoint(): Promise<CheckpointRecord | undefined> {
    const checkpoint = await this.store.getCheckpoint(this.partitionId);
    if (checkpoint !== undefined) {
      this.#checkpoint = checkpoint;
      this.#checkpointEtag = checkpoint.etag;
    }
    return checkpoint;
  }

  /**
   * Re-reads the ownership row and marks this coordinator as preempted if its
   * epoch/ETag token is no longer current. Commit still performs the same check
   * atomically in the store.
   */
  async refreshOwnership(): Promise<boolean> {
    if (this.#lease === undefined) {
      return false;
    }
    const current = await this.store.getOwnership(this.partitionId);
    const valid =
      current !== undefined &&
      current.ownerId === this.workerId &&
      current.epoch === this.#lease.epoch &&
      current.etag === this.#lease.etag;
    if (!valid) {
      this.#preempted = true;
      this.#leaseLost = true;
      this.#stopped = true;
    }
    return valid;
  }

  isCurrentOwner(): Promise<boolean> {
    return this.refreshOwnership();
  }

  verifyLease(): Promise<boolean> {
    return this.refreshOwnership();
  }

  async tryAcquire(
    options: AcquireOptions = {},
  ): Promise<AcquireOwnershipResult> {
    const request: AcquireOwnershipRequest = {
      partitionId: this.partitionId,
      ownerId: this.workerId,
      leaseDurationMs: options.leaseDurationMs ?? this.leaseDurationMs,
      now: options.now,
      preempt: options.preempt,
      expectedEtag: options.expectedEtag,
      epoch: options.epoch,
    };
    const result = await this.store.tryAcquireOwnership(request);
    if (!result.acquired || result.record === undefined) {
      return result;
    }
    this.#adoptRecord(result.record, result.preempted, result.previous);
    const checkpoint = await this.store.getCheckpoint(this.partitionId);
    this.#checkpoint = checkpoint;
    this.#checkpointEtag = checkpoint?.etag ?? null;
    return result;
  }

  async acquire(options: AcquireOptions = {}): Promise<OwnershipLease> {
    const result = await this.tryAcquire(options);
    if (!result.acquired || result.record === undefined) {
      throw new OwnershipConflictError(
        `worker ${this.workerId} could not acquire partition ${this.partitionId}: ${result.reason ?? "unknown"}`,
        result.reason ?? "unknown",
        result.previous,
        result.error,
      );
    }
    if (this.#lease === undefined) {
      throw new OwnershipError("ownership record missing after claim", "invalid-store-result");
    }
    return cloneLease(this.#lease);
  }

  claim(options: AcquireOptions = {}): Promise<OwnershipLease> {
    return this.acquire(options);
  }

  ensureOwnership(options: AcquireOptions = {}): Promise<OwnershipLease> {
    return this.acquire(options);
  }

  preempt(options: Omit<AcquireOptions, "preempt"> = {}): Promise<OwnershipLease> {
    return this.acquire({ ...options, preempt: true });
  }

  async tryRenew(
    options: RenewOptions = {},
  ): Promise<RenewOwnershipResult> {
    if (this.#lease === undefined) {
      return { renewed: false, reason: "not-owned" };
    }
    const result = await this.store.renewOwnership({
      partitionId: this.partitionId,
      ownerId: this.workerId,
      epoch: this.#lease.epoch,
      etag: this.#lease.etag,
      now: options.now,
      leaseDurationMs: options.leaseDurationMs ?? this.leaseDurationMs,
    });
    if (result.renewed && result.record !== undefined) {
      this.#lease = {
        ...this.#lease,
        leaseExpiresAt: result.record.leaseExpiresAt,
      };
      return result;
    }

    this.#leaseLost = true;
    this.#stopped = true;
    this.#lastRenewFailure = result;
    if (
      result.reason === "stale-epoch" ||
      result.reason === "stale-ownership" ||
      result.reason === "not-owned"
    ) {
      this.#preempted = true;
    }
    return result;
  }

  async renew(options: RenewOptions = {}): Promise<boolean> {
    return (await this.tryRenew(options)).renewed;
  }

  renewLease(options: RenewOptions = {}): Promise<boolean> {
    return this.renew(options);
  }

  heartbeat(options: RenewOptions = {}): Promise<boolean> {
    return this.renew(options);
  }

  async release(
    options: ReleaseOptions = {},
  ): Promise<boolean> {
    if (this.#lease === undefined) {
      return false;
    }
    const result: ReleaseOwnershipResult =
      await this.store.releaseOwnership({
        partitionId: this.partitionId,
        ownerId: this.workerId,
        epoch: this.#lease.epoch,
        etag: this.#lease.etag,
        now: options.now,
      });
    if (result.released) {
      this.#lease = undefined;
      this.#stopped = true;
      return true;
    }
    this.#leaseLost = true;
    this.#preempted = true;
    this.#stopped = true;
    return false;
  }

  relinquish(options: ReleaseOptions = {}): Promise<boolean> {
    return this.release(options);
  }

  async commit<T = unknown>(
    input: Batch<T> | number,
    options: CommitOptions = {},
  ): Promise<CheckpointRecord> {
    const sequenceNumber =
      typeof input === "number" ? input : sequenceFromBatch(input);
    if (!Number.isFinite(sequenceNumber)) {
      throw new RangeError("checkpoint sequence number must be finite");
    }

    if (this.#lease === undefined) {
      if (this.#preempted) {
        throw this.#preemptedError("no current lease; epoch was superseded");
      }
      throw new LeaseNotHeldError();
    }

    if (this.#preempted) {
      throw this.#preemptedError();
    }
    if (this.#leaseLost) {
      throw new LeaseLostError(undefined, {
        renewReason: this.#lastRenewFailure?.reason,
      });
    }

    if (
      typeof input !== "number" &&
      options.validateToken !== false &&
      this.#validateBatchToken(input) !== undefined
    ) {
      throw this.#validateBatchToken(input) as CheckpointRejectedError;
    }

    const result = await this.store.commitCheckpoint({
      partitionId: this.partitionId,
      ownerId: this.workerId,
      epoch: this.#lease.epoch,
      ownershipEtag: this.#lease.etag,
      sequenceNumber,
      expectedCheckpointEtag: this.#checkpointEtag,
      now: options.now,
    });

    if (!result.committed || result.checkpoint === undefined) {
      const error = this.#errorForCommitFailure(result);
      this.#lastCommitFailure = result;
      this.#lastCommitError = error;
      if (
        result.reason === CommitReason.StaleEpoch ||
        result.reason === CommitReason.StaleOwnership ||
        result.reason === CommitReason.NotOwned
      ) {
        this.#preempted = true;
        this.#stopped = true;
      }
      throw error;
    }

    this.#checkpoint = result.checkpoint;
    this.#checkpointEtag = result.checkpoint.etag;
    this.#lastCommitFailure = undefined;
    this.#lastCommitError = undefined;
    return result.checkpoint;
  }

  commitBatch<T = unknown>(
    batch: Batch<T>,
    options: CommitOptions = {},
  ): Promise<CheckpointRecord> {
    return this.commit(batch, options);
  }

  async tryCommit<T = unknown>(
    input: Batch<T> | number,
    options: CommitOptions = {},
  ): Promise<CommitCheckpointResult> {
    try {
      const checkpoint = await this.commit(input, options);
      return { committed: true, checkpoint };
    } catch (error) {
      if (error instanceof CheckpointRejectedError) {
        return {
          committed: false,
          reason: error.reason as CommitFailureReason,
          error,
        };
      }
      throw error;
    }
  }

  async updateCheckpoint<T = unknown>(
    sequenceNumber: number,
    batch?: Batch<T>,
    options: CommitOptions = {},
  ): Promise<CheckpointRecord> {
    if (batch !== undefined && options.validateToken !== false) {
      const error = this.#validateBatchToken(batch);
      if (error !== undefined) {
        throw error;
      }
    }
    return this.commit(sequenceNumber, options);
  }

  checkpointBatch<T = unknown>(
    batch: Batch<T>,
    options: CommitOptions = {},
  ): Promise<CheckpointRecord> {
    return this.commit(batch, options);
  }

  createEpochReceiver<T = unknown>(
    options: CreateReceiverOptions<T> = {},
  ): EpochReceiver<T> {
    if (this.#lease === undefined) {
      throw new LeaseNotHeldError(
        "cannot create an epoch receiver without ownership",
      );
    }
    return new EpochReceiver<T>({
      partitionId: this.partitionId,
      ownerId: this.workerId,
      epoch: this.#lease.epoch,
      etag: this.#lease.etag,
      source: options.source ?? options.batchSource ?? options.batches,
    });
  }

  createReceiver<T = unknown>(
    options: CreateReceiverOptions<T> = {},
  ): EpochReceiver<T> {
    return this.createEpochReceiver(options);
  }

  /**
   * Processes one already-received batch. If renewal has failed, the handler
   * is allowed to finish this batch, but the checkpoint remains untouched and
   * no further batch is accepted.
   */
  async processBatch<T = unknown>(
    batch: Batch<T>,
    handler: BatchHandler<T>,
    options: ProcessBatchOptions = {},
  ): Promise<BatchProcessResult> {
    if (this.#leaseLost && this.#processedAfterLeaseLoss) {
      const result: BatchProcessResult = {
        received: true,
        processed: false,
        committed: false,
        reason: "lease-lost",
      };
      if (options.throwOnReject) {
        throw new LeaseLostError();
      }
      return result;
    }

    if (this.#stopped && !this.#leaseLost) {
      const result: BatchProcessResult = {
        received: true,
        processed: false,
        committed: false,
        reason: this.#preempted ? "preempted" : "stopped",
      };
      if (options.throwOnReject) {
        throw this.#preempted
          ? this.#preemptedError()
          : new LeaseLostError();
      }
      return result;
    }

    const tokenError = this.#validateBatchToken(batch);
    if (tokenError !== undefined) {
      if (options.throwOnReject) {
        throw tokenError;
      }
      return {
        received: true,
        processed: false,
        committed: false,
        reason: this.#stopReasonForError(tokenError),
        error: tokenError,
      };
    }

    await handler(batch, this);

    if (this.#leaseLost) {
      this.#processedAfterLeaseLoss = true;
      this.#stopped = true;
      return {
        received: true,
        processed: true,
        committed: false,
        reason: this.#preempted ? "preempted" : "lease-lost",
      };
    }

    try {
      const checkpoint = await this.commit(batch, {
        now: options.now,
      });
      return {
        received: true,
        processed: true,
        committed: true,
        checkpoint,
      };
    } catch (error) {
      if (!(error instanceof CheckpointRejectedError)) {
        throw error;
      }
      this.#stopped = true;
      const result: BatchProcessResult = {
        received: true,
        processed: true,
        committed: false,
        reason: this.#stopReasonForError(error),
        error,
      };
      if (options.throwOnReject) {
        throw error;
      }
      return result;
    }
  }

  #adoptRecord(
    record: OwnershipRecord,
    preempted: boolean,
    previous?: OwnershipRecord,
  ): void {
    this.#lease = {
      partitionId: record.partitionId,
      ownerId: record.ownerId,
      epoch: record.epoch,
      etag: record.etag,
      leaseExpiresAt: record.leaseExpiresAt,
      preempted,
      previousEpoch: previous?.epoch,
    };
    this.#leaseLost = false;
    this.#preempted = false;
    this.#stopped = false;
    this.#processedAfterLeaseLoss = false;
    this.#lastRenewFailure = undefined;
    this.#lastCommitFailure = undefined;
    this.#lastCommitError = undefined;
  }

  #validateBatchToken<T>(
    batch: Batch<T>,
  ): CheckpointRejectedError | undefined {
    if (this.#lease === undefined) {
      return this.#preempted
        ? this.#preemptedError("no current lease")
        : new LeaseNotHeldError();
    }
    if (
      batch.partitionId !== undefined &&
      batch.partitionId !== this.partitionId
    ) {
      return new StaleOwnershipError(
        `batch belongs to partition ${batch.partitionId}, not ${this.partitionId}`,
        { batch },
      );
    }
    if (batch.epoch !== undefined && batch.epoch !== this.#lease.epoch) {
      return new PreemptedError(
        `batch epoch ${batch.epoch} is not the current epoch ${this.#lease.epoch}`,
        { batch },
      );
    }
    if (batch.etag !== undefined && batch.etag !== this.#lease.etag) {
      return new StaleOwnershipError(
        "batch ownership ETag does not match the current lease",
        { batch },
      );
    }
    return undefined;
  }

  #errorForCommitFailure(
    result: CommitCheckpointResult,
  ): CheckpointRejectedError {
    switch (result.reason) {
      case CommitReason.StaleEpoch:
        return this.#preemptedError(
          "ownership epoch was superseded during batch commit",
        );
      case CommitReason.StaleOwnership:
        return new StaleOwnershipError(
          "ownership ETag changed during batch commit",
        );
      case CommitReason.NotOwned:
        return new StaleOwnershipError(
          "partition ownership is no longer held by this worker",
        );
      case CommitReason.CheckpointConflict:
        return new CheckpointConflictError(
          "checkpoint changed concurrently; watermark was not advanced",
        );
      case CommitReason.CheckpointRegression:
        return new CheckpointRegressionError();
      case CommitReason.StorageError:
      default:
        return new CheckpointRejectedError(
          "checkpoint storage failed; watermark was not advanced",
          CommitReason.StorageError,
          { cause: result.error },
        );
    }
  }

  #stopReasonForError(
    error: CheckpointRejectedError,
  ): BatchProcessResult["reason"] {
    if (error instanceof PreemptedError) {
      return "preempted";
    }
    return error.reason as BatchProcessResult["reason"];
  }

  #preemptedError(
    message = "ownership epoch was superseded; batch commit rejected",
  ): PreemptedError {
    return new PreemptedError(message);
  }
}

export {
  PartitionOwnership as PartitionOwner,
  PartitionOwnership as PartitionOwnershipManager,
  PartitionOwnership as OwnershipManager,
  PartitionOwnership as PartitionLeaseManager,
  PartitionOwnership as OwnershipCoordinator,
  PartitionOwnership as PartitionOwnershipCoordinator,
  PartitionOwnership as PartitionCoordinator,
};

export function createPartitionOwnership(
  options: PartitionOwnershipOptions,
): PartitionOwnership {
  return new PartitionOwnership(options);
}

export function createPartitionOwner(
  options: PartitionOwnershipOptions,
): PartitionOwnership {
  return new PartitionOwnership(options);
}
