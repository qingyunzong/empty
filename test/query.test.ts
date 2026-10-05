import { test } from "node:test";
import * as assert from "node:assert/strict";
import { VirtualClock } from "../src/clock";
import {
  queryWithRetry,
  QueryTimeoutError,
  QueryCancelledError,
  Fetcher,
} from "../src/query";

interface ScriptEntry {
  /** Respond this many virtual ms after the attempt starts. */
  delay?: number;
  value?: string;
  error?: Error;
  /** Never respond (forces a timeout). */
  never?: boolean;
}

interface ServerLog {
  times: number[];
  signals: AbortSignal[];
}

/** Simulated transport driven by the virtual clock. Ignores aborts, so
 *  stale responses still arrive late — exactly what fencing must handle. */
function fakeServer(
  clock: VirtualClock,
  script: ScriptEntry[],
  log: ServerLog
): Fetcher<string> {
  return (ctx) => {
    log.times.push(clock.now);
    log.signals.push(ctx.signal);
    const entry = script[ctx.attempt] ?? { never: true };
    if (entry.never) return new Promise<string>(() => {});
    return new Promise<string>((resolve, reject) => {
      clock.setTimeout(() => {
        if (entry.error) reject(entry.error);
        else resolve(entry.value ?? "ok");
      }, entry.delay ?? 0);
    });
  };
}

function serverLog(): ServerLog {
  return { times: [], signals: [] };
}

test("first-attempt success resolves once with one call", async () => {
  const clock = new VirtualClock();
  const log = serverLog();
  const q = queryWithRetry<string>({
    clock,
    timeoutMs: 100,
    retryDelays: [200, 400],
    fetcher: fakeServer(clock, [{ delay: 30, value: "ok" }], log),
  });
  let deliveries = 0;
  const seen: string[] = [];
  q.promise.then((v) => {
    deliveries++;
    seen.push(v);
  });
  await clock.runUntilIdle();
  await q.promise;
  assert.deepEqual(seen, ["ok"]);
  assert.equal(deliveries, 1);
  assert.equal(q.calls, 1);
  assert.deepEqual(log.times, [0]);
  assert.equal(clock.now, 30);
});

test("timeout triggers retry after fixed-table delay", async () => {
  const clock = new VirtualClock();
  const log = serverLog();
  const q = queryWithRetry<string>({
    clock,
    timeoutMs: 100,
    retryDelays: [200, 400],
    fetcher: fakeServer(
      clock,
      [{ never: true }, { delay: 10, value: "second" }],
      log
    ),
  });
  const result = await (async () => {
    await clock.runUntilIdle();
    return q.promise;
  })();
  assert.equal(result, "second");
  assert.equal(q.calls, 2);
  // attempt 0 at t=0, timeout at t=100, retry after table delay 200 -> t=300
  assert.deepEqual(log.times, [0, 300]);
  assert.equal(log.signals[0]!.aborted, true, "timed-out attempt is aborted");
  assert.equal(log.signals[1]!.aborted, false);
});

test("late success from stale attempt must not overwrite newer result", async () => {
  const clock = new VirtualClock();
  const log = serverLog();
  const q = queryWithRetry<string>({
    clock,
    timeoutMs: 100,
    retryDelays: [50],
    fetcher: fakeServer(
      clock,
      [
        { delay: 150, value: "stale" }, // arrives after its timeout
        { delay: 10, value: "fresh" },
      ],
      log
    ),
  });
  const deliveries: string[] = [];
  q.promise.then((v) => deliveries.push(v));
  await clock.runUntilIdle(); // stale response at t=150 fires after settle
  const result = await q.promise;
  assert.equal(result, "fresh");
  assert.deepEqual(deliveries, ["fresh"], "exactly one delivery, new generation wins");
  assert.equal(q.calls, 2);
  assert.deepEqual(log.times, [0, 150]);
});

test("exhausted retry table rejects with QueryTimeoutError", async () => {
  const clock = new VirtualClock();
  const log = serverLog();
  const q = queryWithRetry<string>({
    clock,
    timeoutMs: 100,
    retryDelays: [10, 20],
    fetcher: fakeServer(clock, [], log), // every attempt hangs
  });
  const outcome = q.promise.then(
    () => "resolved" as const,
    (err: unknown) => err
  );
  await clock.runUntilIdle();
  const err = await outcome;
  assert.ok(err instanceof QueryTimeoutError, "rejects with QueryTimeoutError");
  assert.equal((err as QueryTimeoutError).attempts, 3);
  assert.equal(q.calls, 3, "1 initial + 2 table retries");
  // t=0 attempt0, t=100 timeout, t=110 attempt1, t=210 timeout,
  // t=230 attempt2, t=330 final timeout
  assert.deepEqual(log.times, [0, 110, 230]);
  assert.equal(clock.now, 330);
  assert.ok(log.signals.every((s) => s.aborted), "all attempts aborted");
});

test("cancel during retry wait terminates everything, retry never fires", async () => {
  const clock = new VirtualClock();
  const log = serverLog();
  const q = queryWithRetry<string>({
    clock,
    timeoutMs: 100,
    retryDelays: [50, 50],
    fetcher: fakeServer(clock, [], log),
  });
  const outcome = q.promise.then(
    () => "resolved" as const,
    (err: unknown) => err
  );
  await clock.advance(100); // attempt 0 times out, retry scheduled at t=150
  assert.equal(q.calls, 1);
  q.cancel();
  await clock.runUntilIdle();
  const err = await outcome;
  assert.ok(err instanceof QueryCancelledError);
  assert.equal(q.calls, 1, "scheduled retry was cancelled");
  assert.equal(log.signals[0]!.aborted, true);
  assert.equal(clock.pending, 0, "no timers left behind");
});

test("cancel with in-flight attempt aborts it and ignores late response", async () => {
  const clock = new VirtualClock();
  const log = serverLog();
  const q = queryWithRetry<string>({
    clock,
    timeoutMs: 1000,
    retryDelays: [50],
    fetcher: fakeServer(clock, [{ delay: 500, value: "late" }], log),
  });
  const outcome = q.promise.then(
    () => "resolved" as const,
    (err: unknown) => err
  );
  await clock.advance(100);
  q.cancel();
  await clock.runUntilIdle(); // late "late" response fires at t=500
  const err = await outcome;
  assert.ok(err instanceof QueryCancelledError);
  assert.equal(log.signals[0]!.aborted, true, "in-flight attempt aborted");
  assert.equal(q.calls, 1);
});

test("same tick: success event enqueued before timeout wins", async () => {
  const clock = new VirtualClock();
  let deliver!: (value: string) => void;
  // Enqueue the success event BEFORE the query creates its timeout timer,
  // so at t=100 the success event has the lower sequence number.
  clock.setTimeout(() => deliver("win"), 100);
  const fetcher: Fetcher<string> = () =>
    new Promise<string>((resolve) => {
      deliver = resolve;
    });
  const q = queryWithRetry<string>({
    clock,
    timeoutMs: 100,
    retryDelays: [50],
    fetcher,
  });
  await clock.runUntilIdle();
  const result = await q.promise;
  assert.equal(result, "win");
  assert.equal(q.calls, 1, "no retry: success beat the timeout");
});

test("same tick: timeout event enqueued first wins, late success fenced", async () => {
  const clock = new VirtualClock();
  const log = serverLog();
  // Server responds with delay === timeoutMs; the query's timeout timer is
  // enqueued before the fetcher runs, so the timeout event fires first.
  const q = queryWithRetry<string>({
    clock,
    timeoutMs: 100,
    retryDelays: [50],
    fetcher: fakeServer(
      clock,
      [
        { delay: 100, value: "too-late" },
        { delay: 10, value: "fresh" },
      ],
      log
    ),
  });
  const deliveries: string[] = [];
  q.promise.then((v) => deliveries.push(v));
  await clock.runUntilIdle();
  const result = await q.promise;
  assert.equal(result, "fresh");
  assert.deepEqual(deliveries, ["fresh"]);
  assert.equal(q.calls, 2);
  assert.deepEqual(log.times, [0, 150]);
});

test("unique delivery: cancel after settle is a no-op", async () => {
  const clock = new VirtualClock();
  const log = serverLog();
  const q = queryWithRetry<string>({
    clock,
    timeoutMs: 100,
    retryDelays: [50],
    fetcher: fakeServer(clock, [{ delay: 10, value: "done" }], log),
  });
  let settled = 0;
  q.promise.then(() => settled++, () => settled++);
  await clock.runUntilIdle();
  q.cancel(); // must not flip the settled promise
  await clock.runUntilIdle();
  assert.equal(await q.promise, "done");
  assert.equal(settled, 1);
  assert.equal(q.calls, 1);
});
