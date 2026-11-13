import { EpochReceiver } from "./epoch-receiver.ts";
import type { BatchSource } from "./epoch-receiver.ts";
import type {
  Batch,
  BatchHandler,
  BatchProcessResult,
  CheckpointRecord,
  Clock,
  CollectorResult,
  CollectorStopReason,
} from "./types.ts";
import type { PartitionOwnership } from "./partition-ownership.ts";

export interface TelemetryCollectorOptions<T = unknown> {
  ownership?: PartitionOwnership;
  owner?: PartitionOwnership;
  coordinator?: PartitionOwnership;
  receiver?: EpochReceiver<T>;
  source?: BatchSource<T>;
  batchSource?: BatchSource<T>;
  process?: BatchHandler<T>;
  handler?: BatchHandler<T>;
  onBatch?: BatchHandler<T>;
  processor?: BatchHandler<T>;
  processBatch?: BatchHandler<T>;
  autoRenew?: boolean;
  renewLeadMs?: number;
  maxBatches?: number;
  initialCheckpoint?: number;
  now?: Clock;
}

/**
 * Drives a partition's epoch receiver through the ownership coordinator.
 * A lease loss stops receiving new batches; the coordinator itself still
 * lets the currently executing batch finish without moving the watermark.
 */
export class TelemetryCollector<T = unknown> {
  readonly ownership: PartitionOwnership;
  readonly receiver: EpochReceiver<T>;
  readonly autoRenew: boolean;
  readonly renewLeadMs: number;
  readonly #handler: BatchHandler<T>;
  readonly #now: Clock;
  readonly #maxBatches?: number;
  #nextRenewAt?: number;

  constructor(options: TelemetryCollectorOptions<T>) {
    const ownership =
      options.ownership ?? options.owner ?? options.coordinator;
    if (ownership === undefined) {
      throw new TypeError("ownership coordinator is required");
    }
    const handler =
      options.process ??
      options.handler ??
      options.onBatch ??
      options.processor ??
      options.processBatch;
    if (handler === undefined) {
      throw new TypeError("a batch process handler is required");
    }
    this.ownership = ownership;
    this.receiver =
      options.receiver ??
      ownership.createEpochReceiver<T>({
        source: options.source ?? options.batchSource,
      });
    this.autoRenew = options.autoRenew ?? false;
    this.renewLeadMs =
      options.renewLeadMs ?? Math.max(1, ownership.leaseDurationMs / 2);
    this.#handler = handler;
    this.#now = options.now ?? Date.now;
    this.#maxBatches = options.maxBatches;
    this.#resetRenewDeadline();
  }

  async processNextBatch(): Promise<BatchProcessResult | undefined> {
    if (this.ownership.stopped) {
      return {
        processed: false,
        committed: false,
        reason: this.ownership.leaseLost
          ? "lease-lost"
          : this.ownership.preempted
            ? "preempted"
            : "stopped",
      };
    }

    if (this.autoRenew) {
      const now = this.#now();
      if (this.#nextRenewAt !== undefined && now >= this.#nextRenewAt) {
        const renewed = await this.ownership.renew({ now });
        this.#resetRenewDeadline();
        if (!renewed) {
          return {
            processed: false,
            committed: false,
            reason: "lease-lost",
          };
        }
      }
    }

    const batch = await this.receiver.receiveBatch();
    if (batch === undefined) {
      return undefined;
    }

    return this.ownership.processBatch(batch, this.#handler, {
      now: this.#now(),
    });
  }

  async run(): Promise<CollectorResult> {
    let batchesReceived = 0;
    let batchesProcessed = 0;
    let batchesCommitted = 0;
    let stopReason: CollectorStopReason = "source-exhausted";
    let error: Error | undefined;

    while (true) {
      if (
        this.#maxBatches !== undefined &&
        batchesReceived >= this.#maxBatches
      ) {
        stopReason = "max-batches";
        break;
      }

      let result: BatchProcessResult | undefined;
      try {
        result = await this.processNextBatch();
      } catch (caught) {
        error =
          caught instanceof Error ? caught : new Error(String(caught));
        stopReason = "error";
        break;
      }

      if (result === undefined) {
        stopReason = "source-exhausted";
        break;
      }
      if (result.received === true) {
        batchesReceived += 1;
      }
      if (result.processed) {
        batchesProcessed += 1;
      }
      if (result.committed) {
        batchesCommitted += 1;
      }
      if (!result.committed) {
        stopReason = result.reason ?? "error";
        break;
      }
      if (this.ownership.stopped) {
        stopReason = "stopped";
        break;
      }
    }

    return {
      batchesReceived,
      batchesProcessed,
      batchesCommitted,
      checkpoint: this.ownership.checkpoint,
      stopReason,
      error,
    };
  }

  async checkpoint(): Promise<CheckpointRecord | undefined> {
    return this.ownership.getCheckpoint();
  }

  #resetRenewDeadline(): void {
    const expiresAt = this.ownership.leaseExpiresAt;
    this.#nextRenewAt =
      expiresAt === undefined
        ? undefined
        : expiresAt - this.renewLeadMs;
  }
}

export {
  TelemetryCollector as PartitionProcessor,
  TelemetryCollector as TelemetryPartitionCollector,
  TelemetryCollector as TelemetryProcessor,
  TelemetryCollector as EventProcessor,
};

export function processPartition<T = unknown>(
  options: TelemetryCollectorOptions<T>,
): Promise<CollectorResult> {
  return new TelemetryCollector(options).run();
}

export const runCollector = processPartition;
