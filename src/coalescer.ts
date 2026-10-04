import { SystemClock, type Clock } from "./clock.js";

export type ComputeFn<T> = (key: string, signal: AbortSignal) => Promise<T>;

export interface CoalescerOptions {
  /** Virtual/real milliseconds a failure stays cached. 0 disables failure caching. */
  errorCacheMs?: number;
  clock?: Clock;
}

export interface Stats {
  /** Times the underlying compute function was actually invoked. */
  calls: number;
  /** Fetches that joined an already in-flight computation. */
  joins: number;
  /** Fetches served from the failure cache without calling compute. */
  failureCacheHits: number;
  /** Times an in-flight computation was aborted because its last waiter cancelled. */
  aborts: number;
  /** Late settlements dropped because their generation was already gone. */
  staleSettlements: number;
}

export interface FetchHandle<T> {
  readonly promise: Promise<T>;
  cancel(): void;
}

interface Entry<T> {
  readonly generation: number;
  readonly controller: AbortController;
  waiters: number;
  settled: boolean;
  promise: Promise<T>;
}

interface FailureRecord {
  readonly error: unknown;
  readonly expiresAt: number;
}

export function abortError(message = "cancelled"): DOMException {
  return new DOMException(message, "AbortError");
}

export class RequestCoalescer<T> {
  private readonly compute: ComputeFn<T>;
  private readonly errorCacheMs: number;
  private readonly clock: Clock;

  private readonly inflight = new Map<string, Entry<T>>();
  private readonly failures = new Map<string, FailureRecord>();
  private generationCounter = 0;

  private readonly counters: Stats = {
    calls: 0,
    joins: 0,
    failureCacheHits: 0,
    aborts: 0,
    staleSettlements: 0,
  };

  constructor(compute: ComputeFn<T>, options: CoalescerOptions = {}) {
    this.compute = compute;
    this.errorCacheMs = options.errorCacheMs ?? 0;
    this.clock = options.clock ?? new SystemClock();
  }

  stats(): Stats {
    return { ...this.counters };
  }

  fetch(key: string): FetchHandle<T> {
    const cached = this.failures.get(key);
    if (cached !== undefined) {
      if (this.clock.now() < cached.expiresAt) {
        this.counters.failureCacheHits++;
        return { promise: Promise.reject(cached.error), cancel: () => {} };
      }
      this.failures.delete(key);
    }

    let entry = this.inflight.get(key);
    if (entry === undefined) {
      entry = this.start(key);
    } else {
      this.counters.joins++;
    }
    entry.waiters++;
    return this.makeHandle(key, entry);
  }

  private start(key: string): Entry<T> {
    const entry: Entry<T> = {
      generation: ++this.generationCounter,
      controller: new AbortController(),
      waiters: 0,
      settled: false,
      promise: undefined as unknown as Promise<T>,
    };
    this.counters.calls++;
    this.inflight.set(key, entry);

    let invoked: Promise<T>;
    try {
      invoked = Promise.resolve(this.compute(key, entry.controller.signal));
    } catch (error) {
      invoked = Promise.reject(error);
    }
    const shared = invoked.then(
        (value) => {
          // Generation guard: only commit if this entry is still the current
          // generation for the key. If the last waiter cancelled, the entry
          // was removed and a late completion must not resurrect it.
          if (this.inflight.get(key) !== entry) {
            this.counters.staleSettlements++;
            return value;
          }
          entry.settled = true;
          this.inflight.delete(key);
          return value;
        },
        (error: unknown) => {
          if (this.inflight.get(key) !== entry) {
            this.counters.staleSettlements++;
            throw error;
          }
          entry.settled = true;
          this.inflight.delete(key);
          if (this.errorCacheMs > 0) {
            this.failures.set(key, {
              error,
              expiresAt: this.clock.now() + this.errorCacheMs,
            });
          }
          throw error;
        },
      );
    // Waiters attach their own handlers, but once every waiter has cancelled
    // nobody is left to observe the shared promise; keep it from surfacing as
    // an unhandled rejection.
    shared.catch(() => {});
    entry.promise = shared;
    return entry;
  }

  private makeHandle(key: string, entry: Entry<T>): FetchHandle<T> {
    let cancelled = false;
    let rejectWaiter!: (error: unknown) => void;

    const promise = new Promise<T>((resolve, reject) => {
      rejectWaiter = reject;
      entry.promise.then(
        (value) => {
          if (!cancelled) resolve(value);
        },
        (error: unknown) => {
          if (!cancelled) reject(error);
        },
      );
    });

    const cancel = (): void => {
      if (cancelled || entry.settled) return;
      cancelled = true;
      rejectWaiter(abortError());
      entry.waiters--;
      if (entry.waiters === 0 && this.inflight.get(key) === entry) {
        // Last waiter gone: terminate the computation and drop the generation
        // so a late settlement is recognised as stale.
        this.inflight.delete(key);
        entry.controller.abort();
        this.counters.aborts++;
      }
    };

    return { promise, cancel };
  }
}
