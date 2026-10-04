import { deferred, type Deferred } from "./deferred.js";

export interface SubscribeOptions {
  /** Maximum number of buffered (committed + reserved) messages. Must be >= 1. */
  capacity?: number;
}

export interface PublishOptions {
  /** Cancels a (possibly blocked) publish. Reservations already made are released. */
  signal?: AbortSignal;
}

/** A slot reserved in a subscription's bounded queue. Exactly one of commit()/release() takes effect. */
interface Reservation<T> {
  commit(value: T): void;
  release(): void;
}

interface SlotWaiter<T> {
  grant: Deferred<Reservation<T> | null>;
  canceled: boolean;
}

interface LockWaiter {
  grant: Deferred<void>;
  canceled: boolean;
}

const DEFAULT_CAPACITY = 16;
const DONE: IteratorResult<never> = { value: undefined, done: true };

/**
 * One subscriber's bounded queue, exposed as an AsyncIterableIterator.
 *
 * - `next()` resolves with buffered messages in FIFO order, or waits.
 * - `return()` closes only this subscription: buffered messages are dropped,
 *   pending `next()` calls resolve done, and in-flight publishers skip it.
 * - `end()` (used by `Topic.close()`) stops new deliveries but lets the
 *   consumer drain already-buffered messages before observing `done`.
 */
export class Subscription<T> implements AsyncIterableIterator<T> {
  readonly capacity: number;
  #buffer: T[] = [];
  #reserved = 0;
  #slotWaiters: Array<SlotWaiter<T>> = [];
  #takeWaiters: Array<Deferred<IteratorResult<T>>> = [];
  #closed = false;
  readonly #onClose: (sub: Subscription<T>) => void;

  constructor(capacity: number, onClose: (sub: Subscription<T>) => void) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be an integer >= 1, got ${capacity}`);
    }
    this.capacity = capacity;
    this.#onClose = onClose;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Number of queue slots currently in use (buffered messages + outstanding reservations). */
  get pending(): number {
    return this.#buffer.length + this.#reserved;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#buffer.length > 0) {
      const value = this.#buffer.shift() as T;
      this.#freeSlot();
      return Promise.resolve({ value, done: false });
    }
    if (this.#closed) {
      return Promise.resolve(DONE as IteratorResult<T>);
    }
    const waiter = deferred<IteratorResult<T>>();
    this.#takeWaiters.push(waiter);
    return waiter.promise;
  }

  /** Closes only this subscription (async-iterator protocol). Idempotent. */
  return(): Promise<IteratorResult<T>> {
    this.#close(true);
    return Promise.resolve(DONE as IteratorResult<T>);
  }

  /**
   * Stops new deliveries to this subscription but keeps buffered messages
   * available for draining. Called by `Topic.close()`; may also be called
   * directly. Idempotent.
   */
  end(): void {
    this.#close(false);
  }

  /**
   * Acquires a slot reservation for one message.
   * Resolves to `null` when the subscription is (or becomes) closed, so the
   * publisher simply skips it. Rejects with the abort reason when `signal`
   * fires while waiting for a free slot.
   */
  acquireSlot(signal?: AbortSignal): Promise<Reservation<T> | null> {
    if (this.#closed) return Promise.resolve(null);
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#slotWaiters.length === 0 && this.pending < this.capacity) {
      this.#reserved++;
      return Promise.resolve(this.#makeReservation());
    }
    const waiter: SlotWaiter<T> = { grant: deferred(), canceled: false };
    this.#slotWaiters.push(waiter);
    if (signal) {
      const onAbort = () => {
        waiter.canceled = true;
        const index = this.#slotWaiters.indexOf(waiter);
        if (index >= 0) this.#slotWaiters.splice(index, 1);
        waiter.grant.reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      waiter.grant.promise.then(cleanup, cleanup);
    }
    return waiter.grant.promise;
  }

  #makeReservation(): Reservation<T> {
    let settled = false;
    return {
      commit: (value: T) => {
        if (settled) return;
        settled = true;
        this.#reserved--;
        if (this.#closed) {
          this.#freeSlot();
          return;
        }
        this.#buffer.push(value);
        this.#pumpTakers();
      },
      release: () => {
        if (settled) return;
        settled = true;
        this.#reserved--;
        this.#freeSlot();
      },
    };
  }

  /** A slot became available; hand it to the next non-canceled waiter (FIFO). */
  #freeSlot(): void {
    while (this.#slotWaiters.length > 0 && this.pending < this.capacity) {
      const waiter = this.#slotWaiters.shift() as SlotWaiter<T>;
      if (waiter.canceled) continue;
      this.#reserved++;
      waiter.grant.resolve(this.#makeReservation());
    }
  }

  /** Hand buffered messages to consumers waiting in next(). */
  #pumpTakers(): void {
    while (this.#takeWaiters.length > 0 && this.#buffer.length > 0) {
      const taker = this.#takeWaiters.shift() as Deferred<IteratorResult<T>>;
      const value = this.#buffer.shift() as T;
      this.#freeSlot();
      taker.resolve({ value, done: false });
    }
  }

  #close(dropBuffer: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose(this);
    if (dropBuffer) this.#buffer.length = 0;
    // Unblock publishers waiting for a slot: they skip this subscription.
    for (const waiter of this.#slotWaiters.splice(0)) {
      if (!waiter.canceled) waiter.grant.resolve(null);
    }
    // Consumers waiting in next() finish. (When waiting, the buffer is empty.)
    for (const taker of this.#takeWaiters.splice(0)) {
      taker.resolve(DONE as IteratorResult<T>);
    }
  }
}

/**
 * A pub/sub topic. `publish()` delivers one message to every current
 * subscriber and applies backpressure: when a slow subscriber's bounded
 * queue is full, `publish()` waits until space frees up (or its signal
 * aborts, in which case all reservations made for that message are released).
 *
 * Publishes are serialized per topic, so every subscriber observes messages
 * in the same FIFO order.
 */
export class Topic<T> {
  #subs = new Set<Subscription<T>>();
  #closed = false;
  #lockHeld = false;
  #lockQueue: Array<LockWaiter> = [];

  get closed(): boolean {
    return this.#closed;
  }

  get subscriberCount(): number {
    return this.#subs.size;
  }

  subscribe(options: SubscribeOptions = {}): Subscription<T> {
    if (this.#closed) throw new Error("Topic is closed");
    const sub = new Subscription<T>(options.capacity ?? DEFAULT_CAPACITY, (s) => {
      this.#subs.delete(s);
    });
    this.#subs.add(sub);
    return sub;
  }

  /**
   * Delivers `value` to every current subscriber. Resolves with the number of
   * subscriptions that actually received the message. Waits while any
   * subscriber's queue is full; rejects with the abort reason if
   * `options.signal` fires first (releasing all reservations).
   */
  async publish(value: T, options: PublishOptions = {}): Promise<number> {
    const { signal } = options;
    if (this.#closed) throw new Error("Topic is closed");
    signal?.throwIfAborted();
    await this.#acquireLock(signal);
    try {
      if (this.#closed) throw new Error("Topic is closed");
      signal?.throwIfAborted();
      const subs = [...this.#subs];
      // Phase 1: reserve one slot per subscriber.
      const reservations: Array<Reservation<T> | null> = [];
      try {
        for (const sub of subs) {
          signal?.throwIfAborted();
          reservations.push(await sub.acquireSlot(signal));
        }
        signal?.throwIfAborted();
      } catch (err) {
        // Canceled (or failed) mid-reservation: free every slot we took.
        for (const reservation of reservations) reservation?.release();
        throw err;
      }
      // Phase 2: commit. A subscription that closed meanwhile is skipped;
      // everyone else still gets the message.
      let delivered = 0;
      for (let i = 0; i < subs.length; i++) {
        const reservation = reservations[i] as Reservation<T> | null;
        const sub = subs[i] as Subscription<T>;
        if (reservation === null || sub.closed) {
          reservation?.release();
          continue;
        }
        reservation.commit(value);
        delivered++;
      }
      return delivered;
    } finally {
      this.#releaseLock();
    }
  }

  /**
   * Ends all subscriptions gracefully (buffered messages remain drainable)
   * and rejects future publishes/subscribes.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const sub of [...this.#subs]) sub.end();
  }

  #acquireLock(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.#lockHeld) {
      this.#lockHeld = true;
      return Promise.resolve();
    }
    const waiter: LockWaiter = { grant: deferred(), canceled: false };
    this.#lockQueue.push(waiter);
    if (signal) {
      const onAbort = () => {
        waiter.canceled = true;
        const index = this.#lockQueue.indexOf(waiter);
        if (index >= 0) this.#lockQueue.splice(index, 1);
        waiter.grant.reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      waiter.grant.promise.then(cleanup, cleanup);
    }
    return waiter.grant.promise;
  }

  #releaseLock(): void {
    while (this.#lockQueue.length > 0) {
      const waiter = this.#lockQueue.shift() as LockWaiter;
      if (waiter.canceled) continue;
      waiter.grant.resolve(); // lock ownership transfers; #lockHeld stays true
      return;
    }
    this.#lockHeld = false;
  }
}
