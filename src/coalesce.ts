import { SystemScheduler } from './scheduler.js';
import type { Scheduler } from './scheduler.js';

/** Rejection reason delivered to a waiter whose handle was cancelled. */
export class CancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CancelledError';
  }
}

export interface CoalescerOptions {
  /** How long a failure stays cached for a key. <= 0 disables caching. */
  failureTtlMs: number;
  /** Time source. Defaults to real timers; inject a ManualScheduler in tests. */
  scheduler?: Scheduler;
}

export interface Handle<T> {
  readonly promise: Promise<T>;
  /**
   * Detach this waiter. Idempotent. The shared computation is only aborted
   * once EVERY waiter of its generation has cancelled.
   */
  cancel(): void;
}

interface Waiter<T> {
  settled: boolean;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

interface Entry<T> {
  /** Monotonic generation id, for observability and stale-entry checks. */
  readonly gen: number;
  readonly controller: AbortController;
  readonly waiters: Set<Waiter<T>>;
  activeWaiters: number;
}

interface FailureRecord {
  readonly error: unknown;
  readonly timer: unknown;
}

/**
 * Key-based in-flight request coalescing.
 *
 * - Concurrent `run()` calls with the same key share ONE computation.
 * - Each waiter gets its own promise; cancelling one never affects the rest.
 * - The computation's AbortSignal fires only when its last waiter cancels.
 * - Failures are cached per key for `failureTtlMs` (scheduler time).
 * - A completion arriving after its generation was torn down (last cancel)
 *   is dropped: it can neither overwrite a newer generation nor populate
 *   the failure cache. Old generations are never resurrected.
 */
export class Coalescer {
  private readonly failureTtlMs: number;
  private readonly scheduler: Scheduler;
  private readonly inflight = new Map<string, Entry<unknown>>();
  private readonly failures = new Map<string, FailureRecord>();
  private genCounter = 0;
  private computeInvocations = 0;

  constructor(options: CoalescerOptions) {
    this.failureTtlMs = options.failureTtlMs;
    this.scheduler = options.scheduler ?? new SystemScheduler();
  }

  /** Total number of times an underlying compute function was invoked. */
  get callCount(): number {
    return this.computeInvocations;
  }

  /** Number of keys with a computation currently in flight. */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /** Whether `key` currently has a cached (not yet expired) failure. */
  hasCachedFailure(key: string): boolean {
    return this.failures.has(key);
  }

  /**
   * Run `compute` for `key`, coalescing with any in-flight call for the
   * same key. When joining an in-flight call, the passed `compute` is
   * ignored — the existing computation's result is shared instead.
   */
  run<T>(key: string, compute: (signal: AbortSignal) => Promise<T>): Handle<T> {
    const cached = this.failures.get(key);
    if (cached !== undefined) {
      return { promise: Promise.reject(cached.error), cancel(): void {} };
    }

    let entry = this.inflight.get(key) as Entry<T> | undefined;
    if (entry === undefined) {
      entry = this.start(key, compute);
    }
    return this.addWaiter(key, entry);
  }

  private start<T>(key: string, compute: (signal: AbortSignal) => Promise<T>): Entry<T> {
    const entry: Entry<T> = {
      gen: ++this.genCounter,
      controller: new AbortController(),
      waiters: new Set(),
      activeWaiters: 0,
    };
    this.inflight.set(key, entry as Entry<unknown>);
    this.computeInvocations++;
    // Defer through Promise.resolve() so a synchronously-throwing compute
    // is treated exactly like an async rejection.
    Promise.resolve()
      .then(() => compute(entry.controller.signal))
      .then(
        (value) => this.complete(key, entry, { ok: true, value }),
        (error: unknown) => this.complete(key, entry, { ok: false, error }),
      );
    return entry;
  }

  private complete<T>(key: string, entry: Entry<T>, outcome: Outcome<T>): void {
    // Generation guard: if this entry is no longer registered, its last
    // waiter already cancelled and the generation was torn down. A newer
    // generation may now own the key — drop this stale outcome entirely.
    if (this.inflight.get(key) !== entry) {
      return;
    }
    this.inflight.delete(key);

    if (outcome.ok) {
      for (const waiter of entry.waiters) {
        if (!waiter.settled) {
          waiter.settled = true;
          waiter.resolve(outcome.value);
        }
      }
    } else {
      this.cacheFailure(key, outcome.error);
      for (const waiter of entry.waiters) {
        if (!waiter.settled) {
          waiter.settled = true;
          waiter.reject(outcome.error);
        }
      }
    }
  }

  private cacheFailure(key: string, error: unknown): void {
    if (this.failureTtlMs <= 0) {
      return;
    }
    const existing = this.failures.get(key);
    if (existing !== undefined) {
      this.scheduler.clearTimeout(existing.timer);
    }
    const record: FailureRecord = {
      error,
      timer: this.scheduler.setTimeout(() => {
        if (this.failures.get(key) === record) {
          this.failures.delete(key);
        }
      }, this.failureTtlMs),
    };
    this.failures.set(key, record);
  }

  private addWaiter<T>(key: string, entry: Entry<T>): Handle<T> {
    let waiter!: Waiter<T>;
    const promise = new Promise<T>((resolve, reject) => {
      waiter = { settled: false, resolve, reject };
    });
    entry.waiters.add(waiter);
    entry.activeWaiters++;

    const cancel = (): void => {
      if (waiter.settled) {
        return;
      }
      waiter.settled = true;
      entry.waiters.delete(waiter);
      entry.activeWaiters--;
      waiter.reject(new CancelledError(`cancelled waiter for key "${key}"`));
      if (entry.activeWaiters === 0 && this.inflight.get(key) === entry) {
        // Last waiter left: tear down the generation and ask the
        // underlying computation to stop. Its eventual settlement will
        // be discarded by the generation guard in complete().
        this.inflight.delete(key);
        entry.controller.abort();
      }
    };

    return { promise, cancel };
  }
}
