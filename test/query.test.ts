import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "../src/clock.js";
import {
  runQuery,
  CancelledError,
  TimeoutError,
  type AttemptContext,
  type AttemptHandle,
  type Operation,
  type QueryHandle,
} from "../src/query.js";

interface RecordedAttempt<T> {
  ctx: AttemptContext<T>;
  startedAt: number;
  cancelled: boolean;
}

function recordingOp<T>(
  clock: VirtualClock,
  respond?: (attempt: RecordedAttempt<T>) => void,
): { op: Operation<T>; attempts: RecordedAttempt<T>[] } {
  const attempts: RecordedAttempt<T>[] = [];
  const op: Operation<T> = (ctx) => {
    const rec: RecordedAttempt<T> = { ctx, startedAt: clock.now, cancelled: false };
    attempts.push(rec);
    respond?.(rec);
    const handle: AttemptHandle = {
      cancel: () => {
        rec.cancelled = true;
      },
    };
    return handle;
  };
  return { op, attempts };
}

interface Tracked<T> {
  deliveries: number;
  value: T | undefined;
  error: Error | undefined;
}

function track<T>(handle: QueryHandle<T>): Tracked<T> {
  const state: Tracked<T> = { deliveries: 0, value: undefined, error: undefined };
  handle.promise.then(
    (value) => {
      state.deliveries += 1;
      state.value = value;
    },
    (error: Error) => {
      state.deliveries += 1;
      state.error = error;
    },
  );
  return state;
}

test("first-attempt success: one call, one delivery", async () => {
  const clock = new VirtualClock();
  const { op, attempts } = recordingOp<string>(clock, (a) => {
    clock.setTimeout(() => a.ctx.succeed("ok"), 50);
  });
  const handle = runQuery(op, { clock, timeout: 100, delays: [10, 20] });
  const state = track(handle);
  clock.runAll();
  await handle.promise;
  assert.equal(state.deliveries, 1);
  assert.equal(state.value, "ok");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.cancelled, false);
});

test("retries follow the fixed delay table", async () => {
  const clock = new VirtualClock();
  const { op, attempts } = recordingOp<string>(clock, (a) => {
    if (a.ctx.generation === 3) {
      clock.setTimeout(() => a.ctx.succeed("third"), 50);
    }
  });
  const handle = runQuery(op, { clock, timeout: 1000, delays: [100, 200] });
  const state = track(handle);
  clock.runAll();
  await handle.promise;
  assert.equal(state.value, "third");
  assert.deepEqual(
    attempts.map((a) => a.startedAt),
    [0, 1100, 2300],
  );
  assert.equal(attempts[0]!.cancelled, true);
  assert.equal(attempts[1]!.cancelled, true);
  assert.equal(attempts[2]!.cancelled, false);
  assert.equal(state.deliveries, 1);
});

test("stale late success does not overwrite the new generation result", async () => {
  const clock = new VirtualClock();
  const { op, attempts } = recordingOp<string>(clock, (a) => {
    if (a.ctx.generation === 2) {
      clock.setTimeout(() => a.ctx.succeed("new"), 20);
    }
  });
  const handle = runQuery(op, { clock, timeout: 100, delays: [50] });
  const state = track(handle);
  // Generation 1 times out at t=100; its success arrives late at t=160,
  // after generation 2 has started (t=150) but before it succeeds (t=170).
  clock.setTimeout(() => attempts[0]!.ctx.succeed("old"), 160);
  clock.runAll();
  await handle.promise;
  assert.equal(state.value, "new");
  assert.equal(state.deliveries, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.cancelled, true);
});

test("same tick, success scheduled first: success wins, no retry", async () => {
  const clock = new VirtualClock();
  const { op, attempts } = recordingOp<string>(clock, (a) => {
    // Scheduled synchronously inside the operation, before the library
    // arms the timeout, so it wins the same-tick race at t=100.
    clock.setTimeout(() => a.ctx.succeed("photo-finish"), 100);
  });
  const handle = runQuery(op, { clock, timeout: 100, delays: [10] });
  const state = track(handle);
  clock.runAll();
  await handle.promise;
  assert.equal(state.value, "photo-finish");
  assert.equal(attempts.length, 1);
  assert.equal(state.deliveries, 1);
});

test("same tick, timeout scheduled first: timeout wins, retry happens", async () => {
  const clock = new VirtualClock();
  const { op, attempts } = recordingOp<string>(clock, (a) => {
    if (a.ctx.generation === 2) {
      clock.setTimeout(() => a.ctx.succeed("retry-result"), 5);
    }
  });
  const handle = runQuery(op, { clock, timeout: 100, delays: [10] });
  const state = track(handle);
  // Success for generation 1 lands on the same tick as its timeout (t=100)
  // but is scheduled after the timeout timer was armed, so it loses.
  clock.setTimeout(() => attempts[0]!.ctx.succeed("too-late"), 100);
  clock.runAll();
  await handle.promise;
  assert.equal(state.value, "retry-result");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.cancelled, true);
  assert.equal(state.deliveries, 1);
});

test("stale success during the retry-delay window is ignored", async () => {
  const clock = new VirtualClock();
  const { op, attempts } = recordingOp<string>(clock, (a) => {
    if (a.ctx.generation === 2) {
      clock.setTimeout(() => a.ctx.succeed("fresh"), 10);
    }
  });
  const handle = runQuery(op, { clock, timeout: 100, delays: [50] });
  const state = track(handle);
  // Generation 1 times out at t=100; its success arrives at t=120, inside
  // the retry-delay window before generation 2 starts at t=150.
  clock.setTimeout(() => attempts[0]!.ctx.succeed("stale"), 120);
  clock.runAll();
  await handle.promise;
  assert.equal(state.value, "fresh");
  assert.equal(attempts.length, 2);
  assert.equal(state.deliveries, 1);
});

test("cancel while attempt in flight terminates it and ignores late success", async () => {
  const clock = new VirtualClock();
  const { op, attempts } = recordingOp<string>(clock);
  const handle = runQuery(op, { clock, timeout: 100, delays: [10, 10] });
  const state = track(handle);
  clock.advance(30);
  handle.cancel();
  // Late success from the cancelled attempt must be ignored.
  attempts[0]!.ctx.succeed("zombie");
  clock.runAll();
  await handle.promise.catch(() => {});
  assert.equal(attempts[0]!.cancelled, true);
  assert.equal(attempts.length, 1);
  assert.equal(state.deliveries, 1);
  assert.ok(state.error instanceof CancelledError);
});

test("cancel during retry delay stops all further attempts", async () => {
  const clock = new VirtualClock();
  const { op, attempts } = recordingOp<string>(clock);
  const handle = runQuery(op, { clock, timeout: 100, delays: [50, 50] });
  const state = track(handle);
  clock.advance(100); // attempt 1 times out, retry scheduled at t=150
  assert.equal(attempts[0]!.cancelled, true);
  clock.advance(20); // t=120, waiting on the retry delay
  handle.cancel();
  clock.runAll();
  await handle.promise.catch(() => {});
  assert.equal(attempts.length, 1);
  assert.ok(state.error instanceof CancelledError);
  assert.equal(state.deliveries, 1);
  assert.equal(clock.pendingCount, 0);
});

test("exhausting the delay table rejects with TimeoutError", async () => {
  const clock = new VirtualClock();
  const { op, attempts } = recordingOp<string>(clock);
  const handle = runQuery(op, { clock, timeout: 10, delays: [5] });
  const state = track(handle);
  clock.runAll();
  await handle.promise.catch(() => {});
  assert.ok(state.error instanceof TimeoutError);
  assert.equal((state.error as TimeoutError).attempts, 2);
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((a) => a.startedAt),
    [0, 15],
  );
  assert.equal(state.deliveries, 1);
});

test("exactly one delivery even with many stale events", async () => {
  const clock = new VirtualClock();
  const { op, attempts } = recordingOp<string>(clock, (a) => {
    if (a.ctx.generation === 2) {
      clock.setTimeout(() => a.ctx.succeed("final"), 10);
    }
  });
  const handle = runQuery(op, { clock, timeout: 100, delays: [10] });
  const state = track(handle);
  // Stale successes and failures from generation 1 after it timed out.
  clock.setTimeout(() => attempts[0]!.ctx.succeed("stale-1"), 150);
  clock.setTimeout(() => attempts[0]!.ctx.fail(new Error("stale-fail")), 160);
  clock.setTimeout(() => attempts[0]!.ctx.succeed("stale-2"), 500);
  clock.runAll();
  await handle.promise;
  assert.equal(state.value, "final");
  assert.equal(state.deliveries, 1);
});
