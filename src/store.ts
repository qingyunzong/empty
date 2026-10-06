export interface SkippedRange {
  /** First skipped version (inclusive). */
  from: number;
  /** Last skipped version (inclusive). */
  to: number;
}

export interface NotificationMeta {
  /** Version of the state being delivered. */
  version: number;
  /**
   * Versions that were coalesced away because this observer was still busy.
   * Null when nothing was skipped since the previous delivery.
   */
  skipped: SkippedRange | null;
}

export type Observer<T> = (state: T, meta: NotificationMeta) => void | Promise<unknown>;

export interface SubscribeOptions<T> {
  /** Receives observer errors. Committed state is never rolled back. */
  onError?: (error: unknown, observer: Observer<T>) => void;
}

export interface Subscription {
  /** True after unsubscribe() has been requested. */
  readonly closed: boolean;
  /**
   * Stops future notifications and resolves once the currently running
   * callback (if any) has finished.
   */
  unsubscribe(): Promise<void>;
}

interface ObserverRecord<T> {
  observer: Observer<T>;
  onError?: (error: unknown, observer: Observer<T>) => void;
  /** Latest committed version not yet delivered to this observer. */
  pendingVersion: number;
  /** Last version actually handed to the callback. */
  deliveredVersion: number;
  /** Resolves when the in-flight callback settles; null when idle. */
  inflight: Promise<void> | null;
  closed: boolean;
}

export class ObservableStore<T> {
  private state: T;
  private version = 0;
  private readonly records = new Set<ObserverRecord<T>>();
  private flushScheduled = false;
  private closed = false;

  constructor(initialState: T) {
    this.state = initialState;
  }

  getState(): T {
    return this.state;
  }

  getVersion(): number {
    return this.version;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Commits synchronously and returns the new version.
   * Observers are always notified asynchronously (microtask).
   */
  setState(next: T | ((previous: T) => T)): number {
    if (this.closed) {
      throw new Error('ObservableStore is closed');
    }
    this.state =
      typeof next === 'function' ? (next as (previous: T) => T)(this.state) : next;
    this.version += 1;
    for (const record of this.records) {
      record.pendingVersion = this.version;
    }
    this.scheduleFlush();
    return this.version;
  }

  subscribe(observer: Observer<T>, options: SubscribeOptions<T> = {}): Subscription {
    if (this.closed) {
      throw new Error('ObservableStore is closed');
    }
    const record: ObserverRecord<T> = {
      observer,
      onError: options.onError,
      pendingVersion: this.version,
      deliveredVersion: this.version,
      inflight: null,
      closed: false,
    };
    this.records.add(record);

    const store = this;
    const subscription: Subscription = {
      get closed() {
        return record.closed;
      },
      unsubscribe: () => {
        if (record.closed) {
          return record.inflight ?? Promise.resolve();
        }
        record.closed = true;
        store.records.delete(record);
        // Wait for the in-flight callback (if any) before resolving.
        return record.inflight ?? Promise.resolve();
      },
    };
    return subscription;
  }

  /**
   * Prevents new commits/subscriptions, drops pending notifications and
   * resolves once every in-flight observer callback has finished.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const inflight = [...this.records]
      .map((record) => record.inflight)
      .filter((promise): promise is Promise<void> => promise !== null);
    this.records.clear();
    await Promise.all(inflight);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.closed) {
      return;
    }
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.closed) {
      return;
    }
    for (const record of [...this.records]) {
      if (record.closed || record.inflight !== null) {
        // Busy observers keep only the latest version; the skipped
        // range is reported on the next delivery.
        continue;
      }
      if (record.pendingVersion <= record.deliveredVersion) {
        continue;
      }
      this.deliver(record);
    }
  }

  private deliver(record: ObserverRecord<T>): void {
    const version = record.pendingVersion;
    const skipped: SkippedRange | null =
      record.deliveredVersion < version - 1
        ? { from: record.deliveredVersion + 1, to: version - 1 }
        : null;
    const meta: NotificationMeta = { version, skipped };

    record.deliveredVersion = version;
    record.inflight = this.invoke(record, meta).finally(() => {
      record.inflight = null;
      // Reentrant commits that happened while this callback ran are
      // delivered in a follow-up microtask.
      if (
        !this.closed &&
        !record.closed &&
        record.pendingVersion > record.deliveredVersion
      ) {
        this.scheduleFlush();
      }
    });
  }

  private async invoke(record: ObserverRecord<T>, meta: NotificationMeta): Promise<void> {
    try {
      await record.observer(this.state, meta);
    } catch (error) {
      // Observer failures never roll back committed state nor stop
      // other observers; they are surfaced via onError.
      record.onError?.(error, record.observer);
    }
  }
}
