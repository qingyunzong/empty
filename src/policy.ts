import type { Clock, TimerId } from "./clock.js";
import type { RetryTokenBucket } from "./tokens.js";

export class HopTimeoutError extends Error {
  constructor(message = "hop budget exhausted") {
    super(message);
    this.name = "HopTimeoutError";
  }
}

export interface HopPolicy {
  maxAttempts: number;
  hedgeDelayMs: number;
  retryBackoffMs: number;
}

export type Transport<T> = (signal: AbortSignal) => Promise<T>;

export interface HopOutcome<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
  attempts: number;
  startedAt: number;
  finishedAt: number;
}

export interface HopOptions<T> {
  transport: Transport<T>;
  policy: HopPolicy;
  budgetMs: number;
  clock: Clock;
  tokens: RetryTokenBucket;
}

export function executeHop<T>(opts: HopOptions<T>): Promise<HopOutcome<T>> {
  const { transport, policy, budgetMs, clock, tokens } = opts;
  const startedAt = clock.now();
  const deadline = startedAt + Math.max(0, budgetMs);

  return new Promise((resolve) => {
    let settled = false;
    let launched = 0;
    let inFlight = 0;
    let lastError: unknown = new HopTimeoutError();
    const controllers = new Set<AbortController>();
    const timers = new Set<TimerId>();
    let deadlineTimer: TimerId | undefined;

    const finish = (outcome: { ok: boolean; value?: T; error?: unknown }): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== undefined) clock.clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      for (const id of timers) clock.clearTimeout(id);
      timers.clear();
      for (const controller of controllers) controller.abort();
      controllers.clear();
      resolve({ ...outcome, attempts: launched, startedAt, finishedAt: clock.now() });
    };

    const scheduleTimer = (ms: number, cb: () => void): TimerId => {
      const id = clock.setTimeout(() => {
        timers.delete(id);
        cb();
      }, ms);
      timers.add(id);
      return id;
    };

    const cancelTimer = (id: TimerId | undefined): void => {
      if (id !== undefined && timers.delete(id)) clock.clearTimeout(id);
    };

    const maybeGiveUp = (): void => {
      if (!settled && inFlight === 0 && timers.size === 0) {
        finish({ ok: false, error: lastError });
      }
    };

    const launch = (): void => {
      if (settled) return;
      if (launched >= policy.maxAttempts) return;
      if (clock.now() >= deadline) return;
      if (launched >= 1 && !tokens.tryAcquire()) return;
      launched += 1;
      inFlight += 1;
      const controller = new AbortController();
      controllers.add(controller);
      const hedgeTimer =
        launched < policy.maxAttempts
          ? scheduleTimer(policy.hedgeDelayMs, () => {
              if (inFlight > 0) launch();
            })
          : undefined;
      Promise.resolve()
        .then(() => transport(controller.signal))
        .then(
          (value) => {
            cancelTimer(hedgeTimer);
            controllers.delete(controller);
            inFlight -= 1;
            finish({ ok: true, value });
          },
          (error) => {
            cancelTimer(hedgeTimer);
            controllers.delete(controller);
            inFlight -= 1;
            if (settled) return;
            lastError = error;
            if (launched < policy.maxAttempts && clock.now() + policy.retryBackoffMs < deadline) {
              scheduleTimer(policy.retryBackoffMs, () => {
                launch();
                maybeGiveUp();
              });
            } else {
              maybeGiveUp();
            }
          },
        );
    };

    deadlineTimer = clock.setTimeout(() => {
      deadlineTimer = undefined;
      lastError = new HopTimeoutError();
      finish({ ok: false, error: lastError });
    }, deadline - startedAt);

    launch();
    maybeGiveUp();
  });
}

export type HopFn = (input: unknown, signal: AbortSignal) => Promise<unknown>;

export interface RouteResult {
  ok: boolean;
  value?: unknown;
  error?: unknown;
  hops: HopOutcome<unknown>[];
  startedAt: number;
  finishedAt: number;
}

export interface RouteOptions {
  hops: HopFn[];
  policy: HopPolicy;
  budgetMs: number;
  clock: Clock;
  tokens: RetryTokenBucket;
  input?: unknown;
}

export async function executeRoute(opts: RouteOptions): Promise<RouteResult> {
  const { hops, policy, budgetMs, clock, tokens } = opts;
  const startedAt = clock.now();
  const deadline = startedAt + Math.max(0, budgetMs);
  const outcomes: HopOutcome<unknown>[] = [];
  let value: unknown = opts.input;

  for (let i = 0; i < hops.length; i += 1) {
    const remainingHops = hops.length - i;
    const remaining = deadline - clock.now();
    const hopBudget = remaining / remainingHops;
    const hop = hops[i];
    const outcome = await executeHop({
      transport: (signal) => hop(value, signal),
      policy,
      budgetMs: hopBudget,
      clock,
      tokens,
    });
    outcomes.push(outcome);
    if (!outcome.ok) {
      return { ok: false, error: outcome.error, hops: outcomes, startedAt, finishedAt: clock.now() };
    }
    value = outcome.value;
  }

  return { ok: true, value, hops: outcomes, startedAt, finishedAt: clock.now() };
}
