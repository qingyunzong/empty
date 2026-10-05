import { VirtualClock, type TimerId } from "./clock.js";

export class TimeoutError extends Error {
  readonly attempts: number;
  constructor(attempts: number) {
    super(`query timed out after ${attempts} attempt(s)`);
    this.name = "TimeoutError";
    this.attempts = attempts;
  }
}

export class CancelledError extends Error {
  constructor() {
    super("query cancelled");
    this.name = "CancelledError";
  }
}

/** Handle for one in-flight attempt; cancel() must terminate its work. */
export interface AttemptHandle {
  cancel(): void;
}

export interface AttemptContext<T> {
  /** Generation of this attempt; starts at 1 and grows per retry. */
  readonly generation: number;
  /** Deliver a success. Ignored if the attempt is stale or already settled. */
  succeed(value: T): void;
  /** Deliver a definitive (non-timeout) failure. */
  fail(error: Error): void;
}

export type Operation<T> = (ctx: AttemptContext<T>) => AttemptHandle;

export interface RetryOptions {
  clock: VirtualClock;
  /** Per-attempt timeout in virtual milliseconds. */
  timeout: number;
  /** Fixed retry-delay table; delays[i] is waited before attempt i+2. */
  delays: readonly number[];
}

export interface QueryHandle<T> {
  readonly promise: Promise<T>;
  /** Terminates all current attempts and rejects with CancelledError. */
  cancel(): void;
}

/**
 * Runs `operation` with per-attempt timeouts, retrying on timeout after
 * delays taken from a fixed table. A late success from a stale generation
 * never overwrites a newer generation's result, and the promise settles
 * exactly once.
 */
export function runQuery<T>(operation: Operation<T>, options: RetryOptions): QueryHandle<T> {
  const { clock, timeout, delays } = options;
  let nextGeneration = 0;
  let activeGeneration = 0;
  let retryIndex = 0;
  let settled = false;
  let currentAttempt: AttemptHandle | null = null;
  let timeoutTimer: TimerId | null = null;
  let retryTimer: TimerId | null = null;

  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const clearTimers = (): void => {
    if (timeoutTimer !== null) {
      clock.clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (retryTimer !== null) {
      clock.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const settleOk = (value: T): void => {
    if (settled) return;
    settled = true;
    clearTimers();
    resolvePromise(value);
  };

  const settleErr = (error: Error): void => {
    if (settled) return;
    settled = true;
    clearTimers();
    rejectPromise(error);
  };

  const onTimeout = (gen: number): void => {
    if (settled || gen !== activeGeneration) return;
    timeoutTimer = null;
    // Invalidate the timed-out generation at once: its late callbacks are
    // stale from this tick on, even before the next attempt starts.
    activeGeneration = 0;
    // Terminate the timed-out attempt; its late callbacks become stale.
    currentAttempt?.cancel();
    currentAttempt = null;
    if (retryIndex < delays.length) {
      const delay = delays[retryIndex]!;
      retryIndex += 1;
      retryTimer = clock.setTimeout(() => {
        retryTimer = null;
        startAttempt();
      }, delay);
    } else {
      settleErr(new TimeoutError(gen));
    }
  };

  const startAttempt = (): void => {
    if (settled) return;
    nextGeneration += 1;
    activeGeneration = nextGeneration;
    const gen = nextGeneration;
    currentAttempt = operation({
      generation: gen,
      succeed: (value) => {
        if (settled || gen !== activeGeneration) return; // stale late success
        settleOk(value);
      },
      fail: (error) => {
        if (settled || gen !== activeGeneration) return;
        settleErr(error);
      },
    });
    if (settled || gen !== activeGeneration) return; // settled synchronously
    // Arm the deadline once the attempt is dispatched. Same-tick races
    // against the attempt's own events are decided by scheduling order.
    timeoutTimer = clock.setTimeout(() => onTimeout(gen), timeout);
  };

  startAttempt();

  return {
    promise,
    cancel(): void {
      if (settled) return;
      settled = true;
      clearTimers();
      // Terminate every attempt still in flight.
      currentAttempt?.cancel();
      currentAttempt = null;
      rejectPromise(new CancelledError());
    },
  };
}
