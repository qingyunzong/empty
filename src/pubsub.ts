/**
 * bounded-pubsub: a topic whose subscriptions are bounded message queues
 * exposed as async iterators.
 *
 * Semantics:
 * - `topic.subscribe({ capacity })` returns an `AsyncIterableIterator` backed
 *   by a FIFO queue that holds at most `capacity` messages.
 * - `topic.publish(value)` snapshots the current subscribers and resolves once
 *   `value` is buffered by every one of them. While any subscriber's queue is
 *   full, the publish blocks (per-subscriber FIFO wait queue).
 * - A blocked publish can be cancelled with an `AbortSignal`; cancelling
 *   removes the waiter and releases its reserved slot so later publishers
 *   can proceed.
 * - `iterator.return()` closes only that subscription: blocked publishers are
 *   unblocked (their message is dropped for this subscription only) and any
 *   pending `next()` settles with `done: true`. Other subscribers are
 *   unaffected, so a publish racing a subscriber exit never loses their
 *   messages.
 */

export interface SubscribeOptions {
  /** Maximum buffered messages for this subscription. Defaults to the topic capacity. */
  capacity?: number;
}

export interface PublishOptions {
  /** Cancels a blocked publish, releasing the reserved queue slot. */
  signal?: AbortSignal;
}

export interface TopicOptions {
  /** Default per-subscription queue capacity. Defaults to 16. */
  capacity?: number;
}

interface PutWaiter<T> {
  value: T;
  resolve: () => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
}

function assertCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

export class Subscription<T> implements AsyncIterableIterator<T> {
  private readonly capacity: number;
  private readonly onClose: () => void;
  private buffer: T[] = [];
  private putWaiters: PutWaiter<T>[] = [];
  private pullWaiter: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  /** @internal */
  constructor(capacity: number, onClose: () => void) {
    assertCapacity(capacity);
    this.capacity = capacity;
    this.onClose = onClose;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Number of messages currently buffered for this subscription. */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Buffers `value` for this subscription. Resolves immediately if the
   * subscription is already closed (the message is dropped for this
   * subscription only). Blocks while the queue is full.
   * @internal
   */
  enqueue(value: T, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    const pull = this.pullWaiter;
    if (pull !== null) {
      this.pullWaiter = null;
      pull({ value, done: false });
      return Promise.resolve();
    }
    if (this.buffer.length < this.capacity) {
      this.buffer.push(value);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: PutWaiter<T> = { value, resolve, reject, cleanup: () => undefined };
      if (signal) {
        const onAbort = () => {
          const index = this.putWaiters.indexOf(waiter);
          if (index !== -1) {
            // Release the reserved slot so later publishers are not stuck behind us.
            this.putWaiters.splice(index, 1);
          }
          reject(abortReason(signal));
        };
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.putWaiters.push(waiter);
    });
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift() as T;
      this.promoteWaiters();
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.pullWaiter = resolve;
    });
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  /** Closes this subscription only, dropping buffered messages. Idempotent. */
  close(): void {
    this.finish(true);
  }

  /**
   * Gracefully closes this subscription: buffered messages remain available
   * until drained, but no new messages are accepted. Idempotent.
   * @internal
   */
  end(): void {
    this.finish(false);
  }

  private finish(dropBuffer: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    if (dropBuffer) {
      // The consumer signalled it is done; buffered messages are dropped.
      this.buffer = [];
    }

    // Unblock publishers first: their message is dropped for this
    // subscription, but the publish as a whole may still proceed elsewhere.
    const waiters = this.putWaiters;
    this.putWaiters = [];
    for (const waiter of waiters) {
      waiter.cleanup();
      waiter.resolve();
    }

    // Then settle any consumer waiting in next(). A pending pull implies an
    // empty buffer, so `done: true` is correct even for a graceful end.
    const pull = this.pullWaiter;
    if (pull !== null) {
      this.pullWaiter = null;
      pull({ value: undefined, done: true });
    }
  }

  private promoteWaiters(): void {
    while (this.buffer.length < this.capacity && this.putWaiters.length > 0) {
      const waiter = this.putWaiters.shift() as PutWaiter<T>;
      waiter.cleanup();
      this.buffer.push(waiter.value);
      waiter.resolve();
    }
  }
}

export class Topic<T> {
  private readonly defaultCapacity: number;
  private readonly subscriptions = new Set<Subscription<T>>();

  /** @internal */
  constructor(options: TopicOptions = {}) {
    const capacity = options.capacity ?? 16;
    assertCapacity(capacity);
    this.defaultCapacity = capacity;
  }

  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  subscribe(options: SubscribeOptions = {}): Subscription<T> {
    const capacity = options.capacity ?? this.defaultCapacity;
    assertCapacity(capacity);
    const subscription = new Subscription<T>(capacity, () => {
      this.subscriptions.delete(subscription);
    });
    this.subscriptions.add(subscription);
    return subscription;
  }

  /**
   * Delivers `value` to every subscriber present at the moment of the call.
   * Resolves once the value is buffered by all of them; blocks while any
   * subscriber's queue is full. Subscribers that close mid-publish simply
   * drop the value; everyone else still receives it.
   */
  async publish(value: T, options: PublishOptions = {}): Promise<void> {
    const targets = [...this.subscriptions];
    await Promise.all(targets.map((sub) => sub.enqueue(value, options.signal)));
  }

  /**
   * Gracefully closes every subscription: no new messages are accepted, but
   * buffered messages remain available until each consumer drains them.
   */
  close(): void {
    for (const subscription of [...this.subscriptions]) {
      subscription.end();
    }
  }
}

export function createTopic<T>(options: TopicOptions = {}): Topic<T> {
  return new Topic<T>(options);
}
