import {
  BufferFullError,
  SequenceNotDeliveredError,
  WindowCancelledError,
} from "./errors.ts";

export type DeliveryState = "pending" | "in-flight" | "acknowledged";
export type InspectedDeliveryState = DeliveryState | "released" | "unknown";

export interface DeliveryWindowOptions {
  /**
   * Maximum number of distinct delivered-but-unacknowledged messages.
   * Redelivering an in-flight message reuses its existing slot.
   */
  capacity: number;
  startSeq?: number;
  /** Maximum number of pushed-but-not-yet-delivered messages. Defaults to unbounded. */
  maxBuffered?: number;
  /** Cancels the window with `signal.reason` when aborted. */
  signal?: AbortSignal;
}

export interface Delivery<T> {
  readonly seq: number;
  readonly value: T;
  /** 1 for the first delivery, incremented for every redelivery. */
  readonly attempt: number;
  readonly redelivered: boolean;
}

export interface AckResult {
  /** Sequence numbers newly marked acknowledged by this call, in ascending order. */
  readonly acknowledged: readonly number[];
  /** Contiguous acknowledged watermark after this call. */
  readonly watermark: number;
  /** Number of messages released (payload dropped) by this call. */
  readonly released: number;
}

export interface RetainedDelivery<T> {
  readonly seq: number;
  readonly value: T;
  readonly attempts: number;
  readonly state: DeliveryState;
}

export interface CancellationReport<T> {
  readonly reason: unknown;
  readonly watermark: number;
  /**
   * Every retained (not yet released) message in ascending sequence order.
   * Acknowledged entries can appear when a selective ack has not yet joined
   * the contiguous prefix.
   */
  readonly retained: readonly RetainedDelivery<T>[];
}

interface Entry<T> {
  seq: number;
  value: T;
  state: DeliveryState;
  attempt: number;
  queued: boolean;
}

interface Waiter<T> {
  resolve(delivery: Delivery<T>): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function assertInteger(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  }
}

export class DeliveryWindow<T> {
  readonly capacity: number;
  readonly startSeq: number;
  readonly maxBuffered: number;

  #watermark: number;
  #nextSeq: number;
  #highestDelivered: number;
  #inFlight = 0;
  #entries = new Map<number, Entry<T>>();
  #pending: Entry<T>[] = [];
  #pendingHead = 0;
  #retry: Entry<T>[] = [];
  #retryHead = 0;
  #waiters: Waiter<T>[] = [];
  #cancelled = false;
  #cancelReason: unknown;
  #cancelReport: CancellationReport<T> | undefined;
  #signal?: AbortSignal;
  #signalHandler?: () => void;

  constructor(options: DeliveryWindowOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("DeliveryWindow options are required");
    }

    assertInteger(options.capacity, "capacity", 1);
    const startSeq = options.startSeq ?? 0;
    assertInteger(startSeq, "startSeq", 0);

    const maxBuffered = options.maxBuffered ?? Number.POSITIVE_INFINITY;
    if (maxBuffered !== Number.POSITIVE_INFINITY) {
      assertInteger(maxBuffered, "maxBuffered", 1);
    }

    this.capacity = options.capacity;
    this.startSeq = startSeq;
    this.maxBuffered = maxBuffered;
    this.#watermark = startSeq - 1;
    this.#nextSeq = startSeq;
    this.#highestDelivered = startSeq - 1;

    if (options.signal !== undefined) {
      this.#signal = options.signal;
      if (options.signal.aborted) {
        this.cancel(options.signal.reason);
      } else {
        this.#signalHandler = () => this.cancel(options.signal?.reason);
        options.signal.addEventListener("abort", this.#signalHandler, {
          once: true,
        });
      }
    }
  }

  /** Highest sequence for which every message at or below it is acknowledged. */
  get watermark(): number {
    return this.#watermark;
  }

  /** Alias for `watermark`: no payload at or below this value is retained. */
  get releasedThrough(): number {
    return this.#watermark;
  }

  /** Number of distinct delivered-but-unacknowledged messages. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Number of pushed messages waiting for their first delivery. */
  get buffered(): number {
    return this.#pending.length - this.#pendingHead;
  }

  get outstanding(): number {
    return this.#inFlight + this.buffered;
  }

  get nextSeq(): number {
    return this.#nextSeq;
  }

  get highestDelivered(): number {
    return this.#highestDelivered;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  get closed(): boolean {
    return this.#cancelled;
  }

  get cancelReason(): unknown {
    return this.#cancelReason;
  }

  /**
   * Assigns the next sequence number and buffers `value`.
   * Throws `BufferFullError` when `maxBuffered` would be exceeded.
   */
  push(value: T): number {
    this.#assertActive();
    if (this.buffered >= this.maxBuffered) {
      throw new BufferFullError(this.buffered, this.maxBuffered);
    }
    if (this.#nextSeq >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Sequence number space exhausted");
    }

    const seq = this.#nextSeq++;
    const entry: Entry<T> = {
      seq,
      value,
      state: "pending",
      attempt: 0,
      queued: false,
    };
    this.#entries.set(seq, entry);
    this.#pending.push(entry);
    this.#pump();
    return seq;
  }

  /** Non-throwing variant of `push`; returns `null` when the buffer is full. */
  tryPush(value: T): number | null {
    try {
      return this.push(value);
    } catch (error) {
      if (error instanceof BufferFullError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Returns the next delivery without waiting. Pending redeliveries are
   * returned first, in the order they were nacked.
   */
  poll(): Delivery<T> | undefined {
    if (this.#cancelled) {
      return undefined;
    }
    return this.#poll();
  }

  /**
   * Resolves with the next delivery. Rejects with `WindowCancelledError` if
   * the window is cancelled, or with the abort reason if `signal` aborts.
   */
  next(signal?: AbortSignal): Promise<Delivery<T>> {
    if (this.#cancelled) {
      return Promise.reject(new WindowCancelledError(this.#cancelReason));
    }

    const delivery = this.#poll();
    if (delivery !== undefined) {
      return Promise.resolve(delivery);
    }
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }

    return new Promise<Delivery<T>>((resolve, reject) => {
      const waiter: Waiter<T> = { resolve, reject, signal };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index !== -1) {
            this.#waiters.splice(index, 1);
          }
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  /**
   * Acknowledges every sequence up to and including `seq`.
   * The watermark only advances across an unbroken prefix of acks.
   */
  ackCumulative(seq: number): AckResult {
    this.#assertActive();
    assertInteger(seq, "seq", this.startSeq);
    this.#assertDelivered(seq);

    const previousWatermark = this.#watermark;
    const acknowledged: number[] = [];
    for (let current = this.#watermark + 1; current <= seq; current++) {
      this.#markAcknowledged(current, acknowledged);
    }
    this.#advanceWatermark();

    return this.#ackResult(previousWatermark, acknowledged);
  }

  /** Alias for `ackCumulative`, matching offset-based broker APIs. */
  ack(seq: number): AckResult {
    return this.ackCumulative(seq);
  }

  /**
   * Acknowledges only the supplied sequence numbers. Out-of-order acks are
   * retained until every earlier sequence has also been acknowledged.
   */
  ackSelective(seqs: number | Iterable<number>): AckResult {
    this.#assertActive();
    const values = typeof seqs === "number" ? [seqs] : [...seqs];
    const unique = [...new Set(values)].sort((left, right) => left - right);

    for (const seq of unique) {
      assertInteger(seq, "seq", this.startSeq);
      this.#assertDelivered(seq);
    }

    const previousWatermark = this.#watermark;
    const acknowledged: number[] = [];
    for (const seq of unique) {
      if (seq > this.#watermark) {
        this.#markAcknowledged(seq, acknowledged);
      }
    }
    this.#advanceWatermark();

    return this.#ackResult(previousWatermark, acknowledged);
  }

  /**
   * Schedules an in-flight message for redelivery. The message keeps its
   * in-flight quota slot, so it cannot consume capacity twice.
   */
  nack(seq: number): boolean {
    this.#assertActive();
    assertInteger(seq, "seq", this.startSeq);

    const entry = this.#entries.get(seq);
    if (entry === undefined || entry.state !== "in-flight") {
      return false;
    }
    if (entry.queued) {
      return true;
    }

    entry.queued = true;
    this.#retry.push(entry);
    this.#pump();
    return true;
  }

  stateOf(seq: number): InspectedDeliveryState {
    if (!Number.isSafeInteger(seq) || seq < this.startSeq || seq >= this.#nextSeq) {
      return "unknown";
    }
    if (seq <= this.#watermark) {
      return "released";
    }
    return this.#entries.get(seq)?.state ?? "unknown";
  }

  /**
   * Permanently stops the window and hands back every retained message.
   * Pending `next()` calls reject with `WindowCancelledError`.
   */
  cancel(reason?: unknown): CancellationReport<T> {
    if (this.#cancelled) {
      return this.#cancelReport as CancellationReport<T>;
    }

    this.#cancelled = true;
    this.#cancelReason = reason;
    this.#detachSignal();

    const retained = [...this.#entries.values()]
      .sort((left, right) => left.seq - right.seq)
      .map((entry) =>
        Object.freeze({
          seq: entry.seq,
          value: entry.value,
          attempts: entry.attempt,
          state: entry.state,
        }),
      );
    const report: CancellationReport<T> = Object.freeze({
      reason,
      watermark: this.#watermark,
      retained: Object.freeze(retained),
    });
    this.#cancelReport = report;

    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) {
      this.#detachWaiter(waiter);
      waiter.reject(new WindowCancelledError(reason));
    }

    this.#pending = [];
    this.#pendingHead = 0;
    this.#retry = [];
    this.#retryHead = 0;
    this.#entries.clear();
    this.#inFlight = 0;

    return report;
  }

  #poll(): Delivery<T> | undefined {
    while (this.#retryHead < this.#retry.length) {
      const entry = this.#retry[this.#retryHead++] as Entry<T>;
      if (!entry.queued) {
        continue;
      }
      entry.queued = false;
      if (entry.state !== "in-flight") {
        continue;
      }
      entry.attempt++;
      this.#compactRetry();
      return {
        seq: entry.seq,
        value: entry.value,
        attempt: entry.attempt,
        redelivered: true,
      };
    }
    this.#compactRetry();

    if (
      this.#pendingHead < this.#pending.length &&
      this.#inFlight < this.capacity
    ) {
      const entry = this.#pending[this.#pendingHead++] as Entry<T>;
      entry.state = "in-flight";
      entry.attempt = 1;
      this.#inFlight++;
      if (entry.seq > this.#highestDelivered) {
        this.#highestDelivered = entry.seq;
      }
      this.#compactPending();
      return {
        seq: entry.seq,
        value: entry.value,
        attempt: 1,
        redelivered: false,
      };
    }

    return undefined;
  }

  #markAcknowledged(seq: number, acknowledged: number[]): void {
    const entry = this.#entries.get(seq);
    if (entry === undefined || entry.state === "acknowledged") {
      return;
    }
    if (entry.state === "in-flight") {
      this.#inFlight--;
    }
    entry.state = "acknowledged";
    entry.queued = false;
    acknowledged.push(seq);
  }

  #advanceWatermark(): void {
    let next = this.#watermark + 1;
    while (next <= this.#highestDelivered) {
      const entry = this.#entries.get(next);
      if (entry === undefined || entry.state !== "acknowledged") {
        break;
      }
      this.#entries.delete(next);
      next++;
    }
    this.#watermark = next - 1;
  }

  #ackResult(previousWatermark: number, acknowledged: number[]): AckResult {
    this.#pump();
    return {
      acknowledged,
      watermark: this.#watermark,
      released: this.#watermark - previousWatermark,
    };
  }

  #pump(): void {
    while (!this.#cancelled && this.#waiters.length > 0) {
      const delivery = this.#poll();
      if (delivery === undefined) {
        return;
      }
      const waiter = this.#waiters.shift() as Waiter<T>;
      this.#detachWaiter(waiter);
      waiter.resolve(delivery);
    }
  }

  #detachWaiter(waiter: Waiter<T>): void {
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  #detachSignal(): void {
    if (this.#signal !== undefined) {
      if (this.#signalHandler !== undefined) {
        this.#signal.removeEventListener("abort", this.#signalHandler);
      }
      this.#signal = undefined;
      this.#signalHandler = undefined;
    }
  }

  #assertActive(): void {
    if (this.#cancelled) {
      throw new WindowCancelledError(this.#cancelReason);
    }
  }

  #assertDelivered(seq: number): void {
    if (seq > this.#highestDelivered) {
      throw new SequenceNotDeliveredError(seq, this.#highestDelivered);
    }
  }

  #compactPending(): void {
    if (
      this.#pendingHead > 1024 &&
      this.#pendingHead * 2 >= this.#pending.length
    ) {
      this.#pending = this.#pending.slice(this.#pendingHead);
      this.#pendingHead = 0;
    }
  }

  #compactRetry(): void {
    if (
      this.#retryHead > 1024 &&
      this.#retryHead * 2 >= this.#retry.length
    ) {
      this.#retry = this.#retry.slice(this.#retryHead);
      this.#retryHead = 0;
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}
