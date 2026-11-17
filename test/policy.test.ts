import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualClock } from "../src/clock.js";
import { RetryTokenBucket } from "../src/tokens.js";
import { executeHop, executeRoute, HopTimeoutError, type HopPolicy } from "../src/policy.js";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Call {
  signal: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

function controllable() {
  const calls: Call[] = [];
  const transport = (signal: AbortSignal) =>
    new Promise<unknown>((resolve, reject) => {
      calls.push({ signal, resolve, reject });
    });
  return { transport, calls };
}

const basePolicy: HopPolicy = { maxAttempts: 3, hedgeDelayMs: 100, retryBackoffMs: 50 };

test("hedge wins out of order: single delivery, loser cancelled", async () => {
  const clock = new ManualClock();
  const tokens = new RetryTokenBucket(10);
  const { transport, calls } = controllable();

  const outcomePromise = executeHop({
    transport,
    policy: basePolicy,
    budgetMs: 1000,
    clock,
    tokens,
  });
  await tick();
  assert.equal(calls.length, 1);

  await clock.advance(100);
  await tick();
  assert.equal(calls.length, 2);

  calls[1].resolve("hedge-response");
  await tick();
  const outcome = await outcomePromise;

  assert.equal(outcome.ok, true);
  assert.equal(outcome.value, "hedge-response");
  assert.equal(outcome.attempts, 2);
  assert.equal(calls[0].signal.aborted, true, "losing attempt must be cancelled");
  assert.equal(calls[1].signal.aborted, false);

  calls[0].resolve("late-primary");
  await clock.advance(2000);
  await tick();
  const again = await outcomePromise;
  assert.equal(again.value, "hedge-response", "late completion must not re-deliver");
  assert.equal(clock.pending, 0, "no timers may survive settlement");
  assert.ok(outcome.finishedAt - outcome.startedAt <= 1000);
});

test("hanging hop settles at deadline and never exceeds caller budget", async () => {
  const clock = new ManualClock();
  const tokens = new RetryTokenBucket(10);
  const { transport, calls } = controllable();

  const outcomePromise = executeHop({
    transport,
    policy: { maxAttempts: 5, hedgeDelayMs: 40, retryBackoffMs: 10 },
    budgetMs: 500,
    clock,
    tokens,
  });
  await tick();
  await clock.advance(500);
  const outcome = await outcomePromise;

  assert.equal(outcome.ok, false);
  assert.ok(outcome.error instanceof HopTimeoutError);
  assert.equal(outcome.finishedAt - outcome.startedAt, 500);
  assert.ok(outcome.attempts <= 5);
  for (const call of calls) {
    assert.equal(call.signal.aborted, true, "in-flight attempts aborted at deadline");
  }
  assert.equal(clock.pending, 0);
});

test("attempt cap bounds retries when every attempt fails", async () => {
  const clock = new ManualClock();
  const tokens = new RetryTokenBucket(10);
  const { transport, calls } = controllable();

  const outcomePromise = executeHop({
    transport,
    policy: { maxAttempts: 3, hedgeDelayMs: 10000, retryBackoffMs: 10 },
    budgetMs: 1000,
    clock,
    tokens,
  });
  await tick();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(calls.length, i + 1);
    calls[i].reject(new Error(`boom-${i}`));
    await tick();
    await clock.advance(10);
    await tick();
  }
  const outcome = await outcomePromise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.attempts, 3);
  assert.equal((outcome.error as Error).message, "boom-2");
  assert.ok(outcome.finishedAt - outcome.startedAt <= 1000);
});

test("global retry tokens cap extra attempts across the hop", async () => {
  const clock = new ManualClock();
  const tokens = new RetryTokenBucket(2);
  const { transport, calls } = controllable();

  const outcomePromise = executeHop({
    transport,
    policy: { maxAttempts: 5, hedgeDelayMs: 10000, retryBackoffMs: 10 },
    budgetMs: 1000,
    clock,
    tokens,
  });
  await tick();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(calls.length, i + 1);
    calls[i].reject(new Error("nope"));
    await tick();
    await clock.advance(10);
    await tick();
  }
  const outcome = await outcomePromise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.attempts, 3, "1 initial attempt + 2 token-funded retries");
  assert.equal(tokens.remaining, 0);
});

test("remaining time forbids retries that would start past the deadline", async () => {
  const clock = new ManualClock();
  const tokens = new RetryTokenBucket(10);
  const { transport, calls } = controllable();

  const outcomePromise = executeHop({
    transport,
    policy: { maxAttempts: 5, hedgeDelayMs: 10000, retryBackoffMs: 60 },
    budgetMs: 100,
    clock,
    tokens,
  });
  await tick();
  calls[0].reject(new Error("first"));
  await tick();
  await clock.advance(60);
  await tick();
  assert.equal(calls.length, 2);
  calls[1].reject(new Error("second"));
  await tick();
  const outcome = await outcomePromise;

  assert.equal(outcome.ok, false);
  assert.equal(outcome.attempts, 2, "next retry would land past the deadline");
  assert.ok(outcome.finishedAt - outcome.startedAt <= 100);
});

test("route splits remaining budget across hops and stops on first failure", async () => {
  const clock = new ManualClock();
  const tokens = new RetryTokenBucket(0);
  const policy: HopPolicy = { maxAttempts: 1, hedgeDelayMs: 10000, retryBackoffMs: 0 };
  const hanging = () => new Promise<unknown>(() => {});

  const resultPromise = executeRoute({
    hops: [hanging, hanging, hanging],
    policy,
    budgetMs: 900,
    clock,
    tokens,
  });
  await tick();
  await clock.advance(300);
  const result = await resultPromise;

  assert.equal(result.ok, false);
  assert.ok(result.error instanceof HopTimeoutError);
  assert.equal(result.hops.length, 1, "later hops never start after a failure");
  assert.equal(result.finishedAt - result.startedAt, 300, "hop 1 of 3 gets one third of budget");
  assert.ok(result.finishedAt - result.startedAt <= 900);
});

test("route propagates remaining budget and chains hop values", async () => {
  const clock = new ManualClock();
  const tokens = new RetryTokenBucket(0);
  const policy: HopPolicy = { maxAttempts: 1, hedgeDelayMs: 10000, retryBackoffMs: 0 };
  const seenInputs: unknown[] = [];

  const timedHop = (latencyMs: number, tag: string) => {
    return (input: unknown) => {
      seenInputs.push(input);
      return new Promise<unknown>((resolve) => {
        clock.setTimeout(() => resolve(`${tag}:${String(input)}`), latencyMs);
      });
    };
  };

  const resultPromise = executeRoute({
    hops: [timedHop(100, "h1"), timedHop(200, "h2"), timedHop(50, "h3")],
    policy,
    budgetMs: 900,
    clock,
    tokens,
    input: "in",
  });
  await tick();
  await clock.advance(350);
  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.equal(result.value, "h3:h2:h1:in");
  assert.deepEqual(seenInputs, ["in", "h1:in", "h2:h1:in"]);
  assert.equal(result.hops.length, 3);
  assert.ok(result.finishedAt - result.startedAt <= 900, "total stays within caller budget");
});

test("route enforces total budget when every hop stalls", async () => {
  const clock = new ManualClock();
  const tokens = new RetryTokenBucket(0);
  const policy: HopPolicy = { maxAttempts: 1, hedgeDelayMs: 10000, retryBackoffMs: 0 };
  const hanging = () => new Promise<unknown>(() => {});

  const resultPromise = executeRoute({
    hops: [hanging, hanging],
    policy,
    budgetMs: 800,
    clock,
    tokens,
  });
  await tick();
  await clock.advance(10_000);
  const result = await resultPromise;

  assert.equal(result.ok, false);
  assert.ok(result.finishedAt - result.startedAt <= 800, "caller budget is a hard ceiling");
});

test("primary failure in flight does not disturb a winning hedge", async () => {
  const clock = new ManualClock();
  const tokens = new RetryTokenBucket(10);
  const { transport, calls } = controllable();

  const outcomePromise = executeHop({
    transport,
    policy: basePolicy,
    budgetMs: 1000,
    clock,
    tokens,
  });
  await tick();
  await clock.advance(100);
  await tick();
  assert.equal(calls.length, 2);

  calls[0].reject(new Error("primary failed"));
  await tick();
  calls[1].resolve("hedge-win");
  await tick();
  const outcome = await outcomePromise;

  assert.equal(outcome.ok, true);
  assert.equal(outcome.value, "hedge-win");
  assert.equal(outcome.attempts, 2);
  assert.equal(clock.pending, 0, "retry timers from the loser are cancelled");
});
