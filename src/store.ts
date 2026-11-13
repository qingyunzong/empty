import type {
  AcquireOwnershipRequest,
  AcquireOwnershipResult,
  CheckpointRecord,
  Clock,
  CommitCheckpointRequest,
  CommitCheckpointResult,
  OwnershipRecord,
  OwnershipSnapshot,
  PartitionStore,
  ReleaseOwnershipRequest,
  ReleaseOwnershipResult,
  RenewOwnershipRequest,
  RenewOwnershipResult,
  StoreOperation,
  StoreOperationName,
} from "./types.ts";
import { CommitFailureReason } from "./types.ts";

export interface MemoryStoreOptions {
  now?: Clock;
  initialEpoch?: number;
  leaseDurationMs?: number;
  recordOperations?: boolean;
}

function cloneOwnership(record: OwnershipRecord): OwnershipRecord {
  return { ...record };
}

function cloneCheckpoint(record: CheckpointRecord): CheckpointRecord {
  return { ...record };
}

/**
 * Deterministic in-memory partition store. Every mutation is serialized through
 * a promise queue so a claim / renew / commit is atomic with respect to another
 * worker. The ETag on an ownership row is stable for the lifetime of an epoch;
 * a preemption creates a new epoch and a new ETag.
 */
export class InMemoryPartitionStore implements PartitionStore {
  readonly #ownerships = new Map<string, OwnershipRecord>();
  readonly #checkpoints = new Map<string, CheckpointRecord>();
  readonly #now: Clock;
  readonly #initialEpoch: number;
  readonly #defaultLeaseDurationMs: number;
  readonly #recordOperations: boolean;
  readonly operations: StoreOperation[] = [];

  #etagCounter = 0;
  #checkpointEtagCounter = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: MemoryStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#initialEpoch = options.initialEpoch ?? 1;
    this.#defaultLeaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.#recordOperations = options.recordOperations ?? true;
  }

  async getOwnership(
    partitionId: string,
  ): Promise<OwnershipRecord | undefined> {
    const record = this.#ownerships.get(partitionId);
    return record === undefined ? undefined : cloneOwnership(record);
  }

  async getCheckpoint(
    partitionId: string,
  ): Promise<CheckpointRecord | undefined> {
    const record = this.#checkpoints.get(partitionId);
    return record === undefined ? undefined : cloneCheckpoint(record);
  }

  snapshot(): OwnershipSnapshot {
    return {
      ownership: [...this.#ownerships.values()].map(cloneOwnership),
      checkpoints: [...this.#checkpoints.values()].map(cloneCheckpoint),
    };
  }

  reset(): void {
    this.#ownerships.clear();
    this.#checkpoints.clear();
    this.operations.length = 0;
    this.#etagCounter = 0;
    this.#checkpointEtagCounter = 0;
  }

  get(partitionId: string): Promise<OwnershipRecord | undefined> {
    return this.getOwnership(partitionId);
  }

  read(partitionId: string): Promise<OwnershipRecord | undefined> {
    return this.getOwnership(partitionId);
  }

  claim(
    request: AcquireOwnershipRequest,
  ): Promise<AcquireOwnershipResult> {
    return this.tryAcquireOwnership(request);
  }

  renew(
    request: RenewOwnershipRequest,
  ): Promise<RenewOwnershipResult> {
    return this.renewOwnership(request);
  }

  release(
    request: ReleaseOwnershipRequest,
  ): Promise<ReleaseOwnershipResult> {
    return this.releaseOwnership(request);
  }

  checkpoint(
    request: CommitCheckpointRequest,
  ): Promise<CommitCheckpointResult> {
    return this.commitCheckpoint(request);
  }

  async seedOwnership(record: OwnershipRecord): Promise<void> {
    this.#ownerships.set(record.partitionId, cloneOwnership(record));
  }

  async seedCheckpoint(record: CheckpointRecord): Promise<void> {
    this.#checkpoints.set(record.partitionId, cloneCheckpoint(record));
  }

  async deleteOwnership(partitionId: string): Promise<boolean> {
    return this.#ownerships.delete(partitionId);
  }

  async tryAcquireOwnership(
    request: AcquireOwnershipRequest,
  ): Promise<AcquireOwnershipResult> {
    try {
      return await this.#exclusive("acquire", request, () => {
        const now = request.now ?? this.#now();
        const ttl = request.leaseDurationMs ?? this.#defaultLeaseDurationMs;
        if (!Number.isFinite(ttl) || ttl <= 0) {
          throw new RangeError("leaseDurationMs must be a positive number");
        }

        const current = this.#ownerships.get(request.partitionId);
        if (request.expectedEtag !== undefined) {
          const matches =
            request.expectedEtag === null
              ? current === undefined
              : current?.etag === request.expectedEtag;
          if (!matches) {
            return {
              acquired: false,
              preempted: false,
              reason: "etag-mismatch" as const,
              previous: current === undefined ? undefined : cloneOwnership(current),
            };
          }
        }

        const requestedEpoch = request.epoch;
        if (
          requestedEpoch !== undefined &&
          (!Number.isInteger(requestedEpoch) || requestedEpoch < 1)
        ) {
          throw new RangeError("epoch must be a positive integer");
        }

        if (current !== undefined && current.leaseExpiresAt > now) {
          const sameOwner = current.ownerId === request.ownerId;
          if (!sameOwner && !request.preempt) {
            return {
              acquired: false,
              preempted: false,
              reason: "lease-active" as const,
              previous: cloneOwnership(current),
            };
          }

          const wantsHigherEpoch =
            requestedEpoch !== undefined &&
            requestedEpoch > current.epoch;
          if (sameOwner && !request.preempt && !wantsHigherEpoch) {
            const refreshed: OwnershipRecord = {
              ...current,
              leaseExpiresAt: now + ttl,
              updatedAt: now,
            };
            this.#ownerships.set(request.partitionId, refreshed);
            return {
              acquired: true,
              preempted: false,
              record: cloneOwnership(refreshed),
              previous: cloneOwnership(current),
            };
          }
        }

        const previousEpoch = current?.epoch;
        let epoch: number;
        if (current === undefined) {
          epoch = requestedEpoch ?? this.#initialEpoch;
        } else if (
          requestedEpoch !== undefined &&
          requestedEpoch > current.epoch
        ) {
          epoch = requestedEpoch;
        } else {
          epoch = Math.max(this.#initialEpoch, current.epoch + 1);
        }

        const record: OwnershipRecord = {
          partitionId: request.partitionId,
          ownerId: request.ownerId,
          epoch,
          etag: this.#nextOwnershipEtag(request.partitionId),
          leaseExpiresAt: now + ttl,
          acquiredAt: now,
          updatedAt: now,
        };
        this.#ownerships.set(request.partitionId, record);

        return {
          acquired: true,
          preempted: current !== undefined,
          record: cloneOwnership(record),
          previous: current === undefined ? undefined : cloneOwnership(current),
          previousEpoch,
        } as AcquireOwnershipResult & { previousEpoch?: number };
      });
    } catch (error) {
      return {
        acquired: false,
        preempted: false,
        reason: "storage-error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async renewOwnership(
    request: RenewOwnershipRequest,
  ): Promise<RenewOwnershipResult> {
    try {
      return await this.#exclusive("renew", request, () => {
        const now = request.now ?? this.#now();
        const ttl = request.leaseDurationMs ?? this.#defaultLeaseDurationMs;
        const current = this.#ownerships.get(request.partitionId);

        if (current === undefined) {
          return { renewed: false, reason: "not-owned" as const };
        }
        if (current.epoch !== request.epoch) {
          return {
            renewed: false,
            reason: "stale-epoch" as const,
            record: cloneOwnership(current),
          };
        }
        if (
          current.ownerId !== request.ownerId ||
          current.etag !== request.etag
        ) {
          return {
            renewed: false,
            reason: "stale-ownership" as const,
            record: cloneOwnership(current),
          };
        }

        const refreshed: OwnershipRecord = {
          ...current,
          leaseExpiresAt: now + ttl,
          updatedAt: now,
        };
        this.#ownerships.set(request.partitionId, refreshed);
        return { renewed: true, record: cloneOwnership(refreshed) };
      });
    } catch (error) {
      return {
        renewed: false,
        reason: "storage-error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async releaseOwnership(
    request: ReleaseOwnershipRequest,
  ): Promise<ReleaseOwnershipResult> {
    try {
      return await this.#exclusive("release", request, () => {
        const current = this.#ownerships.get(request.partitionId);
        if (current === undefined) {
          return { released: false, reason: "not-owned" as const };
        }
        if (current.epoch !== request.epoch) {
          return {
            released: false,
            reason: "stale-epoch" as const,
            record: cloneOwnership(current),
          } as ReleaseOwnershipResult & { record?: OwnershipRecord };
        }
        if (
          current.ownerId !== request.ownerId ||
          current.etag !== request.etag
        ) {
          return { released: false, reason: "stale-ownership" as const };
        }

        this.#ownerships.delete(request.partitionId);
        return { released: true };
      });
    } catch (error) {
      return {
        released: false,
        reason: "storage-error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async commitCheckpoint(
    request: CommitCheckpointRequest,
  ): Promise<CommitCheckpointResult> {
    try {
      return await this.#exclusive("commit", request, () => {
        const now = request.now ?? this.#now();
        const ownership = this.#ownerships.get(request.partitionId);
        const currentCheckpoint = this.#checkpoints.get(request.partitionId);

        if (ownership === undefined) {
          return {
            committed: false,
            reason: CommitFailureReason.NotOwned,
            previous: currentCheckpoint
              ? cloneCheckpoint(currentCheckpoint)
              : undefined,
          };
        }
        if (ownership.epoch !== request.epoch) {
          return {
            committed: false,
            reason: CommitFailureReason.StaleEpoch,
            previous: currentCheckpoint
              ? cloneCheckpoint(currentCheckpoint)
              : undefined,
          };
        }
        if (
          ownership.ownerId !== request.ownerId ||
          ownership.etag !== request.ownershipEtag
        ) {
          return {
            committed: false,
            reason: CommitFailureReason.StaleOwnership,
            previous: currentCheckpoint
              ? cloneCheckpoint(currentCheckpoint)
              : undefined,
          };
        }

        const expected = request.expectedCheckpointEtag;
        if (expected !== undefined) {
          const matches =
            expected === null
              ? currentCheckpoint === undefined
              : currentCheckpoint?.etag === expected;
          if (!matches) {
            return {
              committed: false,
              reason: CommitFailureReason.CheckpointConflict,
              previous: currentCheckpoint
                ? cloneCheckpoint(currentCheckpoint)
                : undefined,
            };
          }
        }

        if (
          currentCheckpoint !== undefined &&
          request.sequenceNumber < currentCheckpoint.sequenceNumber
        ) {
          return {
            committed: false,
            reason: CommitFailureReason.CheckpointRegression,
            previous: cloneCheckpoint(currentCheckpoint),
          };
        }

        const checkpoint: CheckpointRecord = {
          partitionId: request.partitionId,
          sequenceNumber: request.sequenceNumber,
          epoch: request.epoch,
          ownerId: request.ownerId,
          etag: this.#nextCheckpointEtag(request.partitionId),
          updatedAt: now,
        };
        this.#checkpoints.set(request.partitionId, checkpoint);
        return {
          committed: true,
          checkpoint: cloneCheckpoint(checkpoint),
          previous: currentCheckpoint
            ? cloneCheckpoint(currentCheckpoint)
            : undefined,
        };
      });
    } catch (error) {
      return {
        committed: false,
        reason: CommitFailureReason.StorageError,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  protected async beforeOperation(
    _operation: StoreOperationName,
    _request: unknown,
  ): Promise<void> {
    // Extension point for controllable stores.
  }

  #nextOwnershipEtag(partitionId: string): string {
    this.#etagCounter += 1;
    return `own:${partitionId}:${this.#etagCounter}`;
  }

  #nextCheckpointEtag(partitionId: string): string {
    this.#checkpointEtagCounter += 1;
    return `cp:${partitionId}:${this.#checkpointEtagCounter}`;
  }

  #exclusive<T>(
    operation: StoreOperationName,
    request: unknown,
    body: () => T | Promise<T>,
  ): Promise<T> {
    const task = this.#tail.then(async () => {
      const startedAt = this.#now();
      const log: StoreOperation = { operation, request, startedAt };
      try {
        await this.beforeOperation(operation, request);
        const result = await body();
        log.result = result;
        if (this.#recordOperations) {
          this.operations.push(log);
        }
        return result;
      } catch (error) {
        log.error =
          error instanceof Error ? error : new Error(String(error));
        if (this.#recordOperations) {
          this.operations.push(log);
        }
        throw error;
      }
    });
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}

export interface ControllableStoreOptions extends MemoryStoreOptions {
  beforeOperation?: (
    operation: StoreOperationName,
    request: unknown,
    store: ControllablePartitionStore,
  ) => void | Promise<void>;
}

export interface GateHandle {
  readonly entered: Promise<void>;
  readonly release: () => void;
}

interface PendingGate {
  resolveEntered: () => void;
  wait: Promise<void>;
  resolveReleased: () => void;
  predicate?: (request: unknown) => boolean;
}

/**
 * Store used by the competition tests. It can fail the next operation or hold
 * an operation at a deterministic point, without changing the production store
 * semantics.
 */
export class ControllablePartitionStore extends InMemoryPartitionStore {
  readonly #beforeOperationHook?: ControllableStoreOptions["beforeOperation"];
  readonly #oneShotFailures = new Map<StoreOperationName, Error[]>();
  readonly #persistentFailures = new Map<StoreOperationName, Error>();
  readonly #gates = new Map<StoreOperationName, PendingGate[]>();

  constructor(options: ControllableStoreOptions = {}) {
    super(options);
    this.#beforeOperationHook = options.beforeOperation;
  }

  failNext(operation: StoreOperationName, error?: Error): this {
    const queue = this.#oneShotFailures.get(operation) ?? [];
    queue.push(error ?? new Error(`injected ${operation} failure`));
    this.#oneShotFailures.set(operation, queue);
    return this;
  }

  failNextRenew(error?: Error): this {
    return this.failNext("renew", error);
  }

  failNextCommit(error?: Error): this {
    return this.failNext("commit", error);
  }

  failNextAcquire(error?: Error): this {
    return this.failNext("acquire", error);
  }

  setFailure(
    operation: StoreOperationName,
    error: Error | null,
  ): this {
    if (error === null) {
      this.#persistentFailures.delete(operation);
    } else {
      this.#persistentFailures.set(operation, error);
    }
    return this;
  }

  clearFailures(): this {
    this.#oneShotFailures.clear();
    this.#persistentFailures.clear();
    return this;
  }

  holdNext(
    operation: StoreOperationName,
    predicate?: (request: unknown) => boolean,
  ): GateHandle {
    let resolveEntered: () => void = () => {};
    let resolveReleased: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const gate: PendingGate = {
      resolveEntered,
      wait,
      resolveReleased,
      predicate,
    };
    const list = this.#gates.get(operation) ?? [];
    list.push(gate);
    this.#gates.set(operation, list);
    return {
      entered,
      release: () => resolveReleased(),
    };
  }

  protected override async beforeOperation(
    operation: StoreOperationName,
    request: unknown,
  ): Promise<void> {
    const gate = this.#takeGate(operation, request);
    if (gate !== undefined) {
      gate.resolveEntered();
      await gate.wait;
    }
    if (this.#beforeOperationHook !== undefined) {
      await this.#beforeOperationHook(operation, request, this);
    }
    const oneShot = this.#takeFailure(operation);
    if (oneShot !== undefined) {
      throw oneShot;
    }
    const persistent = this.#persistentFailures.get(operation);
    if (persistent !== undefined) {
      throw persistent;
    }
  }

  #takeGate(
    operation: StoreOperationName,
    request: unknown,
  ): PendingGate | undefined {
    const list = this.#gates.get(operation);
    if (list === undefined || list.length === 0) {
      return undefined;
    }
    const index = list.findIndex(
      (gate) => gate.predicate === undefined || gate.predicate(request),
    );
    if (index < 0) {
      return undefined;
    }
    const [gate] = list.splice(index, 1);
    if (list.length === 0) {
      this.#gates.delete(operation);
    }
    return gate;
  }

  #takeFailure(operation: StoreOperationName): Error | undefined {
    const queue = this.#oneShotFailures.get(operation);
    if (queue === undefined || queue.length === 0) {
      return undefined;
    }
    const error = queue.shift();
    if (queue.length === 0) {
      this.#oneShotFailures.delete(operation);
    }
    return error;
  }
}

export {
  InMemoryPartitionStore as MemoryPartitionStore,
  InMemoryPartitionStore as InMemoryStore,
  InMemoryPartitionStore as InMemoryOwnershipStore,
  InMemoryPartitionStore as MemoryOwnershipStore,
  InMemoryPartitionStore as MemoryStore,
  ControllablePartitionStore as ControllableStore,
  ControllablePartitionStore as ControllableMemoryStore,
  ControllablePartitionStore as FakePartitionStore,
  ControllablePartitionStore as ControllableOwnershipStore,
  ControllablePartitionStore as ControllableStorage,
};
