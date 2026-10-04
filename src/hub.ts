/**
 * Versioned subscription hub.
 *
 * Delivery guarantees per subscription:
 *  1. The first delivery is always a `snapshot` at some version V.
 *  2. Increments published while the snapshot Promise is in flight are
 *     buffered and delivered after the snapshot, contiguously: V+1, V+2, ...
 *  3. A subscriber buffer never skips versions silently: on overflow the
 *     pending increments are discarded and an explicit `resync` delivery
 *     (a fresh snapshot at a newer version) is sent instead.
 *  4. `close()` is final. If a snapshot Promise resolves after close, the
 *     subscription is not resurrected: no further deliveries are made.
 */

export type Delivery<S, D> =
  | { type: 'snapshot'; version: number; state: S }
  | { type: 'increment'; version: number; data: D }
  | { type: 'resync'; version: number; state: S }
  | { type: 'closed'; reason: string };

export type Handler<S, D> = (delivery: Delivery<S, D>) => void | Promise<void>;

export interface SubscribeOptions {
  /** Max increments buffered for this subscriber before an explicit resync. */
  bufferSize?: number;
}

export interface HubOptions<S, D> {
  initialState: S;
  /** Pure reducer: applies an increment to the state, returns the next state. */
  apply: (state: S, data: D) => S;
  /**
   * Optional async snapshot serializer. Called with the immutable state
   * captured synchronously at subscription/resync time, so increments
   * published while it runs never corrupt the snapshot.
   */
  snapshot?: (state: S) => S | Promise<S>;
}

export interface Subscription {
  readonly closed: boolean;
  close(reason?: string): void;
}

const DEFAULT_BUFFER_SIZE = 16;

class SubscriptionImpl<S, D> implements Subscription {
  closed = false;
  attaching = true;
  /** Bumped on every attach cycle and on close; stale snapshot results are dropped. */
  generation = 0;
  queue: Delivery<S, D>[] = [];
  delivering = false;
  private closedNotified = false;

  constructor(
    readonly hub: VersionedHub<S, D>,
    readonly handler: Handler<S, D>,
    readonly bufferSize: number,
  ) {}

  close(reason = 'closed-by-client'): void {
    this.hub.closeSubscription(this, reason);
  }

  notifyClosed(reason: string): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    try {
      this.handler({ type: 'closed', reason });
    } catch {
      // A throwing closed-handler must not break the hub.
    }
  }
}

export class VersionedHub<S, D> {
  private state: S;
  private currentVersion = 0;
  private readonly subs = new Set<SubscriptionImpl<S, D>>();
  private readonly applyFn: (state: S, data: D) => S;
  private readonly snapshotFn: (state: S) => S | Promise<S>;
  private hubClosed = false;

  constructor(options: HubOptions<S, D>) {
    this.state = options.initialState;
    this.applyFn = options.apply;
    this.snapshotFn = options.snapshot ?? ((s: S) => s);
  }

  get version(): number {
    return this.currentVersion;
  }

  get subscriberCount(): number {
    return this.subs.size;
  }

  /** Applies the increment, bumps the version, fans out to live subscribers. */
  publish(data: D): number {
    if (this.hubClosed) throw new Error('hub is closed');
    this.state = this.applyFn(this.state, data);
    this.currentVersion += 1;
    const increment: Delivery<S, D> = {
      type: 'increment',
      version: this.currentVersion,
      data,
    };
    for (const sub of this.subs) this.enqueue(sub, increment);
    return this.currentVersion;
  }

  subscribe(handler: Handler<S, D>, options: SubscribeOptions = {}): Subscription {
    const sub = new SubscriptionImpl<S, D>(
      this,
      handler,
      options.bufferSize ?? DEFAULT_BUFFER_SIZE,
    );
    if (this.hubClosed) {
      sub.closed = true;
      sub.notifyClosed('hub-closed');
      return sub;
    }
    this.subs.add(sub);
    this.beginAttach(sub, 'snapshot');
    return sub;
  }

  closeSubscription(sub: SubscriptionImpl<S, D>, reason: string): void {
    if (sub.closed) return;
    sub.closed = true;
    sub.generation += 1; // invalidate any in-flight snapshot Promise
    sub.queue = [];
    this.subs.delete(sub);
    sub.notifyClosed(reason);
  }

  close(): void {
    if (this.hubClosed) return;
    this.hubClosed = true;
    for (const sub of [...this.subs]) this.closeSubscription(sub, 'hub-closed');
  }

  private enqueue(sub: SubscriptionImpl<S, D>, increment: Delivery<S, D>): void {
    if (sub.closed) return;
    if (sub.queue.length >= sub.bufferSize) {
      // Never skip versions silently: drop the backlog and resync explicitly.
      this.beginAttach(sub, 'resync');
      return;
    }
    sub.queue.push(increment);
    if (!sub.attaching) this.pump(sub);
  }

  /**
   * Starts a snapshot cycle: captures version + state synchronously, then
   * waits for the (possibly async) snapshot. Increments published meanwhile
   * are buffered and flushed after the snapshot, keeping versions contiguous.
   */
  private beginAttach(sub: SubscriptionImpl<S, D>, kind: 'snapshot' | 'resync'): void {
    sub.generation += 1;
    const generation = sub.generation;
    sub.attaching = true;
    sub.queue = [];
    const baseVersion = this.currentVersion;
    const capturedState = this.state;
    Promise.resolve()
      .then(() => this.snapshotFn(capturedState))
      .then(
        (snapshot) => {
          // Close (or a newer attach cycle) interleaved with the snapshot
          // Promise: drop the result instead of resurrecting the subscription.
          if (sub.closed || generation !== sub.generation) return;
          sub.queue.unshift({ type: kind, version: baseVersion, state: snapshot });
          sub.attaching = false;
          this.pump(sub);
        },
        () => {
          if (sub.closed || generation !== sub.generation) return;
          this.closeSubscription(sub, 'snapshot-failed');
        },
      );
  }

  /** Serializes deliveries per subscriber; tolerates reentrant publish/close. */
  private pump(sub: SubscriptionImpl<S, D>): void {
    if (sub.delivering || sub.closed || sub.attaching) return;
    sub.delivering = true;
    void (async () => {
      try {
        while (!sub.closed && !sub.attaching) {
          const delivery = sub.queue.shift();
          if (delivery === undefined) break;
          try {
            await sub.handler(delivery);
          } catch {
            this.closeSubscription(sub, 'handler-error');
          }
        }
      } finally {
        sub.delivering = false;
        if (!sub.closed && !sub.attaching && sub.queue.length > 0) this.pump(sub);
      }
    })();
  }
}
