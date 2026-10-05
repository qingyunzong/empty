import test from "node:test";
import assert from "node:assert/strict";
import {
  Scheduler,
  Snapshot,
  TraceEvent,
  ReplayMismatchError,
  TimeoutError,
  CancelledError,
} from "../src/scheduler";
import { demoScheduler, registerDemoTasks } from "./helpers";

const SEED = 42;

async function fullRun(seed: number): Promise<readonly TraceEvent[]> {
  return demoScheduler(seed).run();
}

test("await boundaries are registered as schedulable events", async () => {
  const trace = await fullRun(SEED);
  const registers = trace.filter((e) => e.type === "register");
  const schedules = trace.filter((e) => e.type === "schedule");

  assert.ok(registers.length > 0, "expected register events");
  assert.ok(schedules.length > 0, "expected schedule events");

  // Every register carries an await-boundary id like "worker-a#2".
  for (const e of registers) {
    assert.match(e.boundary ?? "", /^[a-z-]+#\d+$/);
    assert.equal(e.boundary?.startsWith(`${e.task}#`), true);
  }
  // Every schedule event records the ready set it chose from, and the
  // chosen boundary is a member of that set.
  for (const e of schedules) {
    assert.ok(Array.isArray(e.ready) && e.ready.length > 0);
    assert.ok(e.ready!.includes(e.boundary!), `chosen ${e.boundary} not in ready set`);
    const sorted = e.ready!.slice().sort();
    assert.deepEqual(e.ready, sorted, "ready set is stored sorted");
  }
  // Sequence numbers are dense and ordered.
  trace.forEach((e, i) => assert.equal(e.seq, i));
});

test("seed selects the schedule: same seed identical, other seeds diverge", async () => {
  const a = await fullRun(SEED);
  const b = await fullRun(SEED);
  assert.deepEqual(a, b, "same seed must reproduce the exact trace");

  const others: (readonly TraceEvent[])[] = [];
  for (const seed of [1, 7, 99, 123456]) others.push(await fullRun(seed));
  assert.ok(
    others.some((t) => JSON.stringify(t) !== JSON.stringify(a)),
    "at least one other seed must produce a different schedule",
  );
});

test("completion, cancellation and timeout orderings are all recorded", async () => {
  const trace = await fullRun(SEED);
  const seqOf = (pred: (e: TraceEvent) => boolean) => trace.find(pred)?.seq;

  const timeoutSeq = seqOf((e) => e.type === "timeout" && e.task === "worker-b");
  const cancelSeq = seqOf((e) => e.type === "cancel" && e.task === "victim");
  const completeA = seqOf((e) => e.type === "complete" && e.task === "worker-a");
  const completeB = seqOf((e) => e.type === "complete" && e.task === "worker-b");
  const completeCanceller = seqOf((e) => e.type === "complete" && e.task === "canceller");

  assert.ok(timeoutSeq !== undefined, "timeout recorded");
  assert.ok(cancelSeq !== undefined, "cancel recorded");
  assert.ok(completeA !== undefined && completeB !== undefined && completeCanceller !== undefined);

  // The victim never completes and is never scheduled after its cancel.
  assert.equal(seqOf((e) => e.type === "complete" && e.task === "victim"), undefined);
  assert.equal(
    trace.some((e) => e.type === "schedule" && e.task === "victim" && e.seq > cancelSeq!),
    false,
    "cancelled task must not be scheduled again",
  );

  // worker-b's timeout strictly precedes its post-timeout checkpoint.
  const afterTimeout = seqOf(
    (e) => e.type === "register" && e.task === "worker-b" && e.detail === "after-timeout",
  );
  assert.ok(afterTimeout !== undefined && timeoutSeq! < afterTimeout);

  // The canceller's cancel lands between its own fuse-sleep register and its completion.
  assert.ok(cancelSeq! < completeCanceller!);

  // Event order is exactly the recorded seq order.
  const kinds = trace.map((e) => `${e.seq}:${e.type}:${e.task}`);
  assert.equal(kinds.length, trace.length);
});

test("replay of a recorded trace reproduces it exactly", async () => {
  const original = await fullRun(SEED);
  const replayer = demoScheduler(SEED);
  replayer.setReplay(original);
  const replayed = await replayer.run();
  assert.deepEqual(replayed, original);
});

test("replay rejects a mismatched chosen event", async () => {
  const original = (await fullRun(SEED)).slice();
  const firstSchedule = original.findIndex((e) => e.type === "schedule");
  const victim = original[firstSchedule]!;
  // Pick a different member of the same ready set if possible, else swap task.
  const alternative = victim.ready!.find((b) => b !== victim.boundary);
  const tampered: TraceEvent = { ...victim };
  if (alternative !== undefined) {
    tampered.task = alternative.split("#")[0]!;
    tampered.boundary = alternative;
  } else {
    tampered.task = "definitely-not-a-task";
  }
  original[firstSchedule] = tampered;

  const replayer = demoScheduler(SEED);
  replayer.setReplay(original);
  await assert.rejects(replayer.run(), (err: unknown) => {
    assert.ok(err instanceof ReplayMismatchError, `expected ReplayMismatchError, got ${err}`);
    return true;
  });
});

test("replay rejects a mismatched ready event set", async () => {
  const original = (await fullRun(SEED)).slice();
  const firstSchedule = original.findIndex((e) => e.type === "schedule" && e.ready!.length > 1);
  assert.ok(firstSchedule >= 0, "need a schedule step with a non-trivial ready set");
  const victim = original[firstSchedule]!;
  original[firstSchedule] = { ...victim, ready: victim.ready!.slice(1) }; // drop one member

  const replayer = demoScheduler(SEED);
  replayer.setReplay(original);
  await assert.rejects(replayer.run(), (err: unknown) => {
    assert.ok(err instanceof ReplayMismatchError);
    assert.match((err as Error).message, /event set mismatch|trace mismatch/);
    return true;
  });
});

test("replay rejects leftover and divergent traces", async () => {
  const original = await fullRun(SEED);

  // Extra trailing events must be rejected.
  const extended = original.concat([
    { seq: original.length, time: 9999, type: "complete", task: "ghost" },
  ]);
  const replayer1 = demoScheduler(SEED);
  replayer1.setReplay(extended);
  await assert.rejects(replayer1.run(), ReplayMismatchError);

  // A trace produced by a different seed must be rejected.
  const foreign = await fullRun(7);
  const replayer2 = demoScheduler(SEED);
  replayer2.setReplay(foreign);
  await assert.rejects(replayer2.run(), ReplayMismatchError);
});

test("segmented snapshots carry RNG state and match the full run's trace", async () => {
  // 1) Full run, driven step by step, capturing snapshots along the way.
  const full = demoScheduler(SEED);
  const snapshots = new Map<number, Snapshot>();
  const captureAt = new Set([2, 5, 8]);
  for (;;) {
    const progressed = await full.step();
    if (!progressed) break;
    const step = full.getStepCount();
    if (captureAt.has(step)) snapshots.set(step, full.snapshot());
  }
  const fullTrace = full.getTrace().slice();
  assert.equal(snapshots.size, captureAt.size, "all capture points reached");

  // Snapshots must include the random state and pending await boundaries.
  for (const snap of snapshots.values()) {
    assert.equal(typeof snap.rngState, "number");
    assert.ok(snap.pending.length > 0, "snapshot records pending boundaries");
  }

  // 2) Segmented run: restore from each snapshot in turn and continue.
  const marks = [...captureAt].sort((a, b) => a - b);
  let segment = await Scheduler.restore(
    snapshots.get(marks[0]!)!,
    fullTrace.slice(0, snapshots.get(marks[0]!)!.traceLength),
    SEED,
    registerDemoTasks,
  );
  for (let i = 1; i < marks.length; i += 1) {
    await segment.run({ stopAtStep: marks[i]! });
    assert.deepEqual(
      segment.snapshot(),
      snapshots.get(marks[i]!)!,
      `snapshot at step ${marks[i]} must match the full run (rngState included)`,
    );
  }
  await segment.run();
  assert.deepEqual(
    segment.getTrace(),
    fullTrace,
    "segmented run must reproduce the full run's step-by-step trace",
  );
});

test("restore rejects a snapshot that does not match the trace prefix", async () => {
  const full = demoScheduler(SEED);
  await full.run({ stopAtStep: 3 });
  const snap = full.snapshot();
  const prefix = full.getTrace().slice();

  // A prefix that does not belong to this run must be rejected.
  const tamperedPrefix = prefix.map((e) => ({ ...e }));
  tamperedPrefix[0] = { ...tamperedPrefix[0]!, task: "ghost" };
  await assert.rejects(
    Scheduler.restore(snap, tamperedPrefix, SEED, registerDemoTasks),
    ReplayMismatchError,
  );

  // A tampered snapshot (wrong pending set) must also be rejected.
  const tampered: Snapshot = { ...snap, pending: ["ghost#1"] };
  await assert.rejects(
    Scheduler.restore(tampered, prefix, SEED, registerDemoTasks),
    ReplayMismatchError,
  );
});

test("timeout rejects the boundary promise with TimeoutError", async () => {
  const scheduler = new Scheduler({ seed: 1 });
  const observed: string[] = [];
  scheduler.spawn("t", async (ctx) => {
    try {
      await ctx.sleep(100, { timeout: 10 });
      observed.push("no-throw");
    } catch (err) {
      observed.push(err instanceof TimeoutError ? "timeout" : "other");
    }
  });
  await scheduler.run();
  assert.deepEqual(observed, ["timeout"]);
  assert.equal(scheduler.getTrace().some((e) => e.type === "timeout"), true);
});

test("cancel rejects the pending boundary with CancelledError and can be caught", async () => {
  const scheduler = new Scheduler({ seed: 1 });
  const observed: string[] = [];
  scheduler.spawn("target", async (ctx) => {
    try {
      await ctx.sleep(50);
      observed.push("no-throw");
    } catch (err) {
      observed.push(err instanceof CancelledError ? "cancelled" : "other");
    }
    await ctx.checkpoint("after-catch");
  });
  scheduler.spawn("canceller", async (ctx) => {
    await ctx.checkpoint();
    ctx.cancelTask("target");
  });
  await scheduler.run();
  assert.deepEqual(observed, ["cancelled"]);
  const trace = scheduler.getTrace();
  assert.ok(trace.some((e) => e.type === "cancel" && e.task === "target"));
  assert.ok(trace.some((e) => e.type === "complete" && e.task === "target"));
});
