import { VirtualClock, TimerHandle } from "./clock";

export class QueryTimeoutError extends Error {
  readonly attempts: number;
  constructor(attempts: number) {
    super(`query timed out after ${attempts} attempt(s)`);
    this.name = "QueryTimeoutError";
    this.attempts = attempts;
  }
}

export class QueryCancelledError extends Error {
  constructor() {
    super("query cancelled");
    this.name = "QueryCancelledError";
  }
}

export interface AttemptContext {
  /** 0-based generation of this attempt. */
  readonly attempt: number;
  /** Aborted when this attempt times out or the query is cancelled. */
  readonly signal: AbortSignal;
  readonly clock: VirtualClock;
}

export type Fetcher<T> = (ctx: AttemptContext) => Promise<T>;

export interface QueryOptions<T> {
  readonly clock: VirtualClock;
  /** Per-attempt timeout in virtual milliseconds. */
  readonly timeoutMs: number;
  /**
   * Fixed retry-delay table: retryDelays[i] is the wait before retry i.
   * Total attempts = 1 + retryDelays.length.
   */
  readonly retryDelays: readonly number[];
  readonly fetcher: Fetcher<T>;
}

export interface QueryHandle<T> {
  /** Settles exactly once (unique delivery). */
  readonly promise: Promise<T>;
  /** Terminates every in-flight attempt and any pending retry. */
  cancel(): void;
  /** Number of fetcher invocations so far. */
  readonly calls: number;
}

export function queryWithRetry<T>(options: QueryOptions<T>): QueryHandle<T> {
  const { clock, timeoutMs, retryDelays, fetcher } = options;

  let calls = 0;
  let settled = false;
  let cancelled = false;
  let generation = 0;
  let retryTimer: TimerHandle | undefined;
  const active = new Map<number, { controller: AbortController; timeout: TimerHandle }>();

  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  function cleanupAttempt(gen: number): void {
    const entry = active.get(gen);
    if (!entry) return;
    entry.timeout.cancel();
    active.delete(gen);
  }

  function settleResolve(gen: number, value: T): void {
    if (settled || cancelled) return;
    settled = true;
    for (const [g, entry] of active) {
      entry.timeout.cancel();
      if (g !== gen) entry.controller.abort();
    }
    active.clear();
    retryTimer?.cancel();
    resolvePromise(value);
  }

  function settleReject(reason: unknown): void {
    if (settled || cancelled) return;
    settled = true;
    for (const entry of active.values()) {
      entry.timeout.cancel();
      entry.controller.abort();
    }
    active.clear();
    retryTimer?.cancel();
    rejectPromise(reason);
  }

  function startAttempt(gen: number): void {
    const controller = new AbortController();
    const timeout = clock.setTimeout(() => onTimeout(gen), timeoutMs);
    active.set(gen, { controller, timeout });
    calls++;

    let result: Promise<T>;
    try {
      result = Promise.resolve(
        fetcher({ attempt: gen, signal: controller.signal, clock })
      );
    } catch (err) {
      onAttemptFailure(gen, err);
      return;
    }
    result.then(
      (value) => {
        // Generation fence: a late success from a stale attempt must not
        // overwrite a newer generation's outcome.
        if (settled || cancelled || gen !== generation) return;
        cleanupAttempt(gen);
        settleResolve(gen, value);
      },
      (err) => {
        if (settled || cancelled || gen !== generation) return;
        cleanupAttempt(gen);
        onAttemptFailure(gen, err);
      }
    );
  }

  function onAttemptFailure(gen: number, err: unknown): void {
    if (settled || cancelled || gen !== generation) return;
    settleReject(err);
  }

  function onTimeout(gen: number): void {
    if (settled || cancelled || gen !== generation) return;
    const entry = active.get(gen);
    if (entry) {
      entry.controller.abort();
      active.delete(gen);
    }
    const retryIndex = gen;
    if (retryIndex >= retryDelays.length) {
      settleReject(new QueryTimeoutError(gen + 1));
      return;
    }
    generation = gen + 1;
    const delay = retryDelays[retryIndex]!;
    retryTimer = clock.setTimeout(() => {
      retryTimer = undefined;
      if (settled || cancelled) return;
      startAttempt(generation);
    }, delay);
  }

  function cancel(): void {
    if (settled || cancelled) return;
    cancelled = true;
    // Terminate every in-flight attempt and any scheduled retry.
    for (const entry of active.values()) {
      entry.timeout.cancel();
      entry.controller.abort();
    }
    active.clear();
    retryTimer?.cancel();
    retryTimer = undefined;
    rejectPromise(new QueryCancelledError());
  }

  startAttempt(0);

  return {
    promise,
    cancel,
    get calls() {
      return calls;
    },
  };
}
