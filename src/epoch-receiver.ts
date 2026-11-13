import type { Batch, OwnershipLease } from "./types.ts";

export interface ReceivableSource<T> {
  receiveBatch?(): Promise<Batch<T> | undefined> | Batch<T> | undefined;
  close?(): void | Promise<void>;
}

export type BatchSource<T> =
  | ReceivableSource<T>
  | AsyncIterable<Batch<T>>
  | Iterable<Batch<T>>
  | (() =>
      | Promise<Batch<T> | undefined>
      | Batch<T>
      | undefined);

export interface EpochReceiverOptions<T = unknown> {
  partitionId: string;
  epoch: number;
  etag?: string;
  ownerId?: string;
  source?: BatchSource<T>;
  batchSource?: BatchSource<T>;
  batches?: Iterable<Batch<T>> | AsyncIterable<Batch<T>>;
}

function isOptions<T>(
  value: unknown,
): value is EpochReceiverOptions<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "partitionId" in value &&
    "epoch" in value
  );
}

async function* iterate<T>(
  source: Iterable<Batch<T>> | AsyncIterable<Batch<T>>,
): AsyncGenerator<Batch<T>> {
  if (Symbol.asyncIterator in source) {
    for await (const batch of source as AsyncIterable<Batch<T>>) {
      yield batch;
    }
    return;
  }
  for (const batch of source as Iterable<Batch<T>>) {
    yield batch;
  }
}

/**
 * A receiver permanently pinned to one ownership epoch and ownership ETag.
 * Even after the ownership row is preempted, batches produced by this receiver
 * retain the old epoch and ETag so the coordinator can reject their commit.
 */
export class EpochReceiver<T = unknown> {
  readonly partitionId: string;
  readonly epoch: number;
  readonly etag?: string;
  readonly ownerId?: string;

  readonly #queue: Batch<T>[] = [];
  readonly #source?: BatchSource<T>;
  #iterator?: AsyncIterator<Batch<T>>;
  #closed = false;

  constructor(options: EpochReceiverOptions<T>);
  constructor(partitionId: string, epoch: number, options?: Omit<EpochReceiverOptions<T>, "partitionId" | "epoch">);
  constructor(
    first: EpochReceiverOptions<T> | string,
    second?: number,
    third: Omit<EpochReceiverOptions<T>, "partitionId" | "epoch"> = {},
  ) {
    if (isOptions<T>(first)) {
      this.partitionId = first.partitionId;
      this.epoch = first.epoch;
      this.etag = first.etag;
      this.ownerId = first.ownerId;
      this.#source = first.source ?? first.batchSource ?? first.batches;
    } else {
      if (second === undefined) {
        throw new TypeError("epoch is required");
      }
      this.partitionId = first;
      this.epoch = second;
      this.etag = third.etag;
      this.ownerId = third.ownerId;
      this.#source = third.source ?? third.batchSource ?? third.batches;
    }
    if (!Number.isInteger(this.epoch) || this.epoch < 1) {
      throw new RangeError("epoch must be a positive integer");
    }
  }

  static fromLease<T = unknown>(
    lease: OwnershipLease,
    source?: BatchSource<T>,
  ): EpochReceiver<T> {
    return new EpochReceiver<T>({
      partitionId: lease.partitionId,
      ownerId: lease.ownerId,
      epoch: lease.epoch,
      etag: lease.etag,
      source,
    });
  }

  enqueue(batch: Batch<T>): this {
    this.#queue.push(batch);
    return this;
  }

  push(batch: Batch<T>): this {
    return this.enqueue(batch);
  }

  enqueueBatch(batch: Batch<T>): this {
    return this.enqueue(batch);
  }

  close(): void {
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed && this.#queue.length === 0;
  }

  async receiveBatch(): Promise<Batch<T> | undefined> {
    const raw = await this.#nextRaw();
    return raw === undefined ? undefined : this.#stamp(raw);
  }

  receive(): Promise<Batch<T> | undefined> {
    return this.receiveBatch();
  }

  next(): Promise<Batch<T> | undefined> {
    return this.receiveBatch();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Batch<T>> {
    while (true) {
      const batch = await this.receiveBatch();
      if (batch === undefined) {
        return;
      }
      yield batch;
    }
  }

  async #nextRaw(): Promise<Batch<T> | undefined> {
    if (this.#queue.length > 0) {
      return this.#queue.shift();
    }
    if (this.#closed || this.#source === undefined) {
      return undefined;
    }
    if (typeof this.#source === "function") {
      return await this.#source();
    }
    if ("receiveBatch" in this.#source) {
      const fn = this.#source.receiveBatch;
      return fn === undefined ? undefined : await fn.call(this.#source);
    }
    if (this.#iterator === undefined) {
      const source = this.#source as
        | Iterable<Batch<T>>
        | AsyncIterable<Batch<T>>;
      this.#iterator = iterate(source);
    }
    const next = await this.#iterator.next();
    return next.done ? undefined : next.value;
  }

  #stamp(batch: Batch<T>): Batch<T> {
    const normalized: Batch<T> = {
      ...batch,
      partitionId: this.partitionId,
      epoch: this.epoch,
    };
    if (this.etag !== undefined) {
      normalized.etag = this.etag;
    }
    if (this.ownerId !== undefined) {
      normalized.ownerId = this.ownerId;
    }
    if (normalized.sequenceNumber === undefined) {
      if (typeof normalized.offset === "number") {
        normalized.sequenceNumber = normalized.offset;
      } else if (typeof normalized.checkpoint === "number") {
        normalized.sequenceNumber = normalized.checkpoint;
      } else if (typeof normalized.watermark === "number") {
        normalized.sequenceNumber = normalized.watermark;
      }
    }
    return normalized;
  }
}

export class ControllableEpochReceiver<
  T = unknown,
> extends EpochReceiver<T> {
  #receiveFailure?: Error;

  failNextReceive(error: Error = new Error("injected receive failure")): this {
    this.#receiveFailure = error;
    return this;
  }

  override async receiveBatch(): Promise<Batch<T> | undefined> {
    if (this.#receiveFailure !== undefined) {
      const error = this.#receiveFailure;
      this.#receiveFailure = undefined;
      throw error;
    }
    return super.receiveBatch();
  }
}

export {
  EpochReceiver as PartitionEpochReceiver,
  ControllableEpochReceiver as TestEpochReceiver,
};
