import type {
  CheckpointRecord,
  CheckpointStore as CheckpointStoreContract,
  CommitCheckpointRequest,
  CommitCheckpointResult,
} from "./types.ts";

export interface CheckpointStoreOptions {
  now?: () => number;
}

/**
 * Small standalone checkpoint store for callers that do not use the combined
 * partition store. Ownership-checked checkpointing lives in
 * `InMemoryPartitionStore`.
 */
export class InMemoryCheckpointStore
  implements CheckpointStoreContract
{
  readonly #records = new Map<string, CheckpointRecord>();
  readonly #now: () => number;
  #etagCounter = 0;

  constructor(options: CheckpointStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  async getCheckpoint(
    partitionId: string,
  ): Promise<CheckpointRecord | undefined> {
    const record = this.#records.get(partitionId);
    return record === undefined ? undefined : { ...record };
  }

  async commitCheckpoint(
    request: CommitCheckpointRequest,
  ): Promise<CommitCheckpointResult> {
    const current = this.#records.get(request.partitionId);
    const expected = request.expectedCheckpointEtag;
    if (expected !== undefined) {
      const matches =
        expected === null
          ? current === undefined
          : current?.etag === expected;
      if (!matches) {
        return {
          committed: false,
          reason: "checkpoint-conflict",
          previous: current === undefined ? undefined : { ...current },
        };
      }
    }
    if (
      current !== undefined &&
      request.sequenceNumber < current.sequenceNumber
    ) {
      return {
        committed: false,
        reason: "checkpoint-regression",
        previous: { ...current },
      };
    }
    this.#etagCounter += 1;
    const checkpoint: CheckpointRecord = {
      partitionId: request.partitionId,
      sequenceNumber: request.sequenceNumber,
      epoch: request.epoch,
      ownerId: request.ownerId,
      etag: `cp:${request.partitionId}:${this.#etagCounter}`,
      updatedAt: request.now ?? this.#now(),
    };
    this.#records.set(request.partitionId, checkpoint);
    return {
      committed: true,
      checkpoint: { ...checkpoint },
      previous: current === undefined ? undefined : { ...current },
    };
  }
}

export {
  InMemoryCheckpointStore as MemoryCheckpointStore,
  InMemoryCheckpointStore as ControllableCheckpointStore,
};
