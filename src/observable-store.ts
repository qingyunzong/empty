/**
 * ObservableStore: an observable state container.
 *
 * Semantics:
 * - State commits are synchronous and versioned; notifications are always
 *   delivered asynchronously (on a microtask), never inside `set`/`update`.
 * - A throwing observer never rolls back committed state and never prevents
 *   other observers from being notified. Errors are routed to `onObserverError`.
 * - Slow observers are coalesced: while an observer callback is still running,
 *   only the latest committed version is kept. The next delivery carries the
 *   `skipped` version range that was superseded and never delivered.
 * - `unsubscribe()` waits for the currently in-flight callback to finish.
 * - `close()` waits for in-flight callbacks, drops pending notifications and
 *   guarantees no notification is delivered afterwards.
 */

export interface SkippedRange {
  /** First skipped (never delivered) version, inclusive. */
  readonly from: number;
  /** Last skipped (never delivered) version, inclusive. */
  readonly to: number;
}

export interface Snapshot<T> {
  /** Committed state for this notification. */
  readonly value: T;
  /** Monotonic version of the commit, starting at 1. */
  readonly version: number;
  /**
   * Versions that were committed but never delivered to this observer because
   * it was still processing a previous notification. `null` when nothing was
   * skipped.
   */
  readonly skipped: SkippedRange | null;
}

export type Observer<T> = (snapshot: Snapshot<T>) => void | Promise<void>;

export type ObserverErrorHandler = (error: unknown) => void;

export interface Subscription {
  /**
   * Detaches the observer. The returned promise resolves once the currently
   * in-flight callback (if any) has finished. No further notifications are
   * delivered to this observer.
   */
  unsubscribe(): Promise<void>;
  readonly closed: boolean;
}

export interface ObservableStoreOptions {
  /** Called when an observer throws or rejects. Defaults to a no-op. */
  onObserverError?: ObserverErrorHandler;
}

interface Pending<T> {
  value: T;
  version: number;
}

interface ObserverEntry<T> {
  observer: Observer<T>;
  pending: Pending<T> | null;
  running: boolean;
  removed: boolean;
  lastDeliveredVersion: number;
  currentDrain: Promise<void> | null;
}

export class ObservableStore<T> {
  private state: T;
  private version = 0;
  private readonly observers = new Set<ObserverEntry<T>>();
  private flushScheduled = false;
  private isClosed = false;
  private readonly onObserverError: ObserverErrorHandler;

  constructor(initialState: T, options: ObservableStoreOptions = {}) {
    this.state = initialState;
    this.onObserverError = options.onObserverError ?? (() => undefined);
  }

  /** Current committed state. */
  getState(): T {
    return this.state;
  }

  /** Version of the current committed state (0 before the first commit). */
  getVersion(): number {
    return this.version;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Commits `next` synchronously and schedules asynchronous notification.
   * Returns the new version. Throws if the store is closed.
   */
  set(next: T): number {
    if (this.isClosed) {
      throw new Error("ObservableStore is closed");
    }
    this.state = next;
    this.version += 1;
    for (const entry of this.observers) {
      // Coalescing: a slow observer keeps only the latest version.
      entry.pending = { value: next, version: this.version };
    }
    this.scheduleFlush();
    return this.version;
  }

  /** Commits `fn(currentState)`; see `set`. */
  update(fn: (previous: T) => T): number {
    return this.set(fn(this.state));
  }

  subscribe(observer: Observer<T>): Subscription {
    if (this.isClosed) {
      throw new Error("ObservableStore is closed");
    }
    const entry: ObserverEntry<T> = {
      observer,
      pending: null,
      running: false,
      removed: false,
      lastDeliveredVersion: this.version,
      currentDrain: null,
    };
    this.observers.add(entry);

    const subscription: Subscription = {
      get closed() {
        return entry.removed;
      },
      unsubscribe: (): Promise<void> => {
        if (entry.removed) {
          return entry.currentDrain ?? Promise.resolve();
        }
        entry.removed = true;
        entry.pending = null;
        this.observers.delete(entry);
        // Wait for the in-flight callback (drain) to finish, if any.
        return entry.currentDrain ?? Promise.resolve();
      },
    };
    return subscription;
  }

  /**
   * Drops pending notifications, waits for in-flight observer callbacks and
   * guarantees no notification is delivered after the returned promise
   * resolves. Subsequent `set`/`update`/`subscribe` calls throw.
   */
  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    const inFlight: Promise<void>[] = [];
    for (const entry of this.observers) {
      entry.pending = null;
      if (entry.currentDrain) {
        inFlight.push(entry.currentDrain);
      }
    }
    this.observers.clear();
    await Promise.all(inFlight);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.isClosed) {
      return;
    }
    for (const entry of [...this.observers]) {
      if (!entry.running && !entry.removed && entry.pending !== null) {
        entry.currentDrain = this.drain(entry);
      }
    }
  }

  private async drain(entry: ObserverEntry<T>): Promise<void> {
    entry.running = true;
    try {
      while (!this.isClosed && !entry.removed && entry.pending !== null) {
        const { value, version } = entry.pending;
        entry.pending = null;
        const skipped: SkippedRange | null =
          version - entry.lastDeliveredVersion > 1
            ? { from: entry.lastDeliveredVersion + 1, to: version - 1 }
            : null;
        entry.lastDeliveredVersion = version;
        try {
          await entry.observer({ value, version, skipped });
        } catch (error) {
          // Observer failures never roll back committed state and never
          // affect other observers.
          this.onObserverError(error);
        }
      }
    } finally {
      entry.running = false;
      entry.currentDrain = null;
    }
  }
}
