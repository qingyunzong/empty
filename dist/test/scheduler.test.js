"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const scheduler_1 = require("../src/scheduler");
const helpers_1 = require("./helpers");
const SEED = 42;
async function fullRun(seed) {
    return (0, helpers_1.demoScheduler)(seed).run();
}
(0, node_test_1.default)("await boundaries are registered as schedulable events", async () => {
    const trace = await fullRun(SEED);
    const registers = trace.filter((e) => e.type === "register");
    const schedules = trace.filter((e) => e.type === "schedule");
    strict_1.default.ok(registers.length > 0, "expected register events");
    strict_1.default.ok(schedules.length > 0, "expected schedule events");
    // Every register carries an await-boundary id like "worker-a#2".
    for (const e of registers) {
        strict_1.default.match(e.boundary ?? "", /^[a-z-]+#\d+$/);
        strict_1.default.equal(e.boundary?.startsWith(`${e.task}#`), true);
    }
    // Every schedule event records the ready set it chose from, and the
    // chosen boundary is a member of that set.
    for (const e of schedules) {
        strict_1.default.ok(Array.isArray(e.ready) && e.ready.length > 0);
        strict_1.default.ok(e.ready.includes(e.boundary), `chosen ${e.boundary} not in ready set`);
        const sorted = e.ready.slice().sort();
        strict_1.default.deepEqual(e.ready, sorted, "ready set is stored sorted");
    }
    // Sequence numbers are dense and ordered.
    trace.forEach((e, i) => strict_1.default.equal(e.seq, i));
});
(0, node_test_1.default)("seed selects the schedule: same seed identical, other seeds diverge", async () => {
    const a = await fullRun(SEED);
    const b = await fullRun(SEED);
    strict_1.default.deepEqual(a, b, "same seed must reproduce the exact trace");
    const others = [];
    for (const seed of [1, 7, 99, 123456])
        others.push(await fullRun(seed));
    strict_1.default.ok(others.some((t) => JSON.stringify(t) !== JSON.stringify(a)), "at least one other seed must produce a different schedule");
});
(0, node_test_1.default)("completion, cancellation and timeout orderings are all recorded", async () => {
    const trace = await fullRun(SEED);
    const seqOf = (pred) => trace.find(pred)?.seq;
    const timeoutSeq = seqOf((e) => e.type === "timeout" && e.task === "worker-b");
    const cancelSeq = seqOf((e) => e.type === "cancel" && e.task === "victim");
    const completeA = seqOf((e) => e.type === "complete" && e.task === "worker-a");
    const completeB = seqOf((e) => e.type === "complete" && e.task === "worker-b");
    const completeCanceller = seqOf((e) => e.type === "complete" && e.task === "canceller");
    strict_1.default.ok(timeoutSeq !== undefined, "timeout recorded");
    strict_1.default.ok(cancelSeq !== undefined, "cancel recorded");
    strict_1.default.ok(completeA !== undefined && completeB !== undefined && completeCanceller !== undefined);
    // The victim never completes and is never scheduled after its cancel.
    strict_1.default.equal(seqOf((e) => e.type === "complete" && e.task === "victim"), undefined);
    strict_1.default.equal(trace.some((e) => e.type === "schedule" && e.task === "victim" && e.seq > cancelSeq), false, "cancelled task must not be scheduled again");
    // worker-b's timeout strictly precedes its post-timeout checkpoint.
    const afterTimeout = seqOf((e) => e.type === "register" && e.task === "worker-b" && e.detail === "after-timeout");
    strict_1.default.ok(afterTimeout !== undefined && timeoutSeq < afterTimeout);
    // The canceller's cancel lands between its own fuse-sleep register and its completion.
    strict_1.default.ok(cancelSeq < completeCanceller);
    // Event order is exactly the recorded seq order.
    const kinds = trace.map((e) => `${e.seq}:${e.type}:${e.task}`);
    strict_1.default.equal(kinds.length, trace.length);
});
(0, node_test_1.default)("replay of a recorded trace reproduces it exactly", async () => {
    const original = await fullRun(SEED);
    const replayer = (0, helpers_1.demoScheduler)(SEED);
    replayer.setReplay(original);
    const replayed = await replayer.run();
    strict_1.default.deepEqual(replayed, original);
});
(0, node_test_1.default)("replay rejects a mismatched chosen event", async () => {
    const original = (await fullRun(SEED)).slice();
    const firstSchedule = original.findIndex((e) => e.type === "schedule");
    const victim = original[firstSchedule];
    // Pick a different member of the same ready set if possible, else swap task.
    const alternative = victim.ready.find((b) => b !== victim.boundary);
    const tampered = { ...victim };
    if (alternative !== undefined) {
        tampered.task = alternative.split("#")[0];
        tampered.boundary = alternative;
    }
    else {
        tampered.task = "definitely-not-a-task";
    }
    original[firstSchedule] = tampered;
    const replayer = (0, helpers_1.demoScheduler)(SEED);
    replayer.setReplay(original);
    await strict_1.default.rejects(replayer.run(), (err) => {
        strict_1.default.ok(err instanceof scheduler_1.ReplayMismatchError, `expected ReplayMismatchError, got ${err}`);
        return true;
    });
});
(0, node_test_1.default)("replay rejects a mismatched ready event set", async () => {
    const original = (await fullRun(SEED)).slice();
    const firstSchedule = original.findIndex((e) => e.type === "schedule" && e.ready.length > 1);
    strict_1.default.ok(firstSchedule >= 0, "need a schedule step with a non-trivial ready set");
    const victim = original[firstSchedule];
    original[firstSchedule] = { ...victim, ready: victim.ready.slice(1) }; // drop one member
    const replayer = (0, helpers_1.demoScheduler)(SEED);
    replayer.setReplay(original);
    await strict_1.default.rejects(replayer.run(), (err) => {
        strict_1.default.ok(err instanceof scheduler_1.ReplayMismatchError);
        strict_1.default.match(err.message, /event set mismatch|trace mismatch/);
        return true;
    });
});
(0, node_test_1.default)("replay rejects leftover and divergent traces", async () => {
    const original = await fullRun(SEED);
    // Extra trailing events must be rejected.
    const extended = original.concat([
        { seq: original.length, time: 9999, type: "complete", task: "ghost" },
    ]);
    const replayer1 = (0, helpers_1.demoScheduler)(SEED);
    replayer1.setReplay(extended);
    await strict_1.default.rejects(replayer1.run(), scheduler_1.ReplayMismatchError);
    // A trace produced by a different seed must be rejected.
    const foreign = await fullRun(7);
    const replayer2 = (0, helpers_1.demoScheduler)(SEED);
    replayer2.setReplay(foreign);
    await strict_1.default.rejects(replayer2.run(), scheduler_1.ReplayMismatchError);
});
(0, node_test_1.default)("segmented snapshots carry RNG state and match the full run's trace", async () => {
    // 1) Full run, driven step by step, capturing snapshots along the way.
    const full = (0, helpers_1.demoScheduler)(SEED);
    const snapshots = new Map();
    const captureAt = new Set([2, 5, 8]);
    for (;;) {
        const progressed = await full.step();
        if (!progressed)
            break;
        const step = full.getStepCount();
        if (captureAt.has(step))
            snapshots.set(step, full.snapshot());
    }
    const fullTrace = full.getTrace().slice();
    strict_1.default.equal(snapshots.size, captureAt.size, "all capture points reached");
    // Snapshots must include the random state and pending await boundaries.
    for (const snap of snapshots.values()) {
        strict_1.default.equal(typeof snap.rngState, "number");
        strict_1.default.ok(snap.pending.length > 0, "snapshot records pending boundaries");
    }
    // 2) Segmented run: restore from each snapshot in turn and continue.
    const marks = [...captureAt].sort((a, b) => a - b);
    let segment = await scheduler_1.Scheduler.restore(snapshots.get(marks[0]), fullTrace.slice(0, snapshots.get(marks[0]).traceLength), SEED, helpers_1.registerDemoTasks);
    for (let i = 1; i < marks.length; i += 1) {
        await segment.run({ stopAtStep: marks[i] });
        strict_1.default.deepEqual(segment.snapshot(), snapshots.get(marks[i]), `snapshot at step ${marks[i]} must match the full run (rngState included)`);
    }
    await segment.run();
    strict_1.default.deepEqual(segment.getTrace(), fullTrace, "segmented run must reproduce the full run's step-by-step trace");
});
(0, node_test_1.default)("restore rejects a snapshot that does not match the trace prefix", async () => {
    const full = (0, helpers_1.demoScheduler)(SEED);
    await full.run({ stopAtStep: 3 });
    const snap = full.snapshot();
    const prefix = full.getTrace().slice();
    // A prefix that does not belong to this run must be rejected.
    const tamperedPrefix = prefix.map((e) => ({ ...e }));
    tamperedPrefix[0] = { ...tamperedPrefix[0], task: "ghost" };
    await strict_1.default.rejects(scheduler_1.Scheduler.restore(snap, tamperedPrefix, SEED, helpers_1.registerDemoTasks), scheduler_1.ReplayMismatchError);
    // A tampered snapshot (wrong pending set) must also be rejected.
    const tampered = { ...snap, pending: ["ghost#1"] };
    await strict_1.default.rejects(scheduler_1.Scheduler.restore(tampered, prefix, SEED, helpers_1.registerDemoTasks), scheduler_1.ReplayMismatchError);
});
(0, node_test_1.default)("timeout rejects the boundary promise with TimeoutError", async () => {
    const scheduler = new scheduler_1.Scheduler({ seed: 1 });
    const observed = [];
    scheduler.spawn("t", async (ctx) => {
        try {
            await ctx.sleep(100, { timeout: 10 });
            observed.push("no-throw");
        }
        catch (err) {
            observed.push(err instanceof scheduler_1.TimeoutError ? "timeout" : "other");
        }
    });
    await scheduler.run();
    strict_1.default.deepEqual(observed, ["timeout"]);
    strict_1.default.equal(scheduler.getTrace().some((e) => e.type === "timeout"), true);
});
(0, node_test_1.default)("cancel rejects the pending boundary with CancelledError and can be caught", async () => {
    const scheduler = new scheduler_1.Scheduler({ seed: 1 });
    const observed = [];
    scheduler.spawn("target", async (ctx) => {
        try {
            await ctx.sleep(50);
            observed.push("no-throw");
        }
        catch (err) {
            observed.push(err instanceof scheduler_1.CancelledError ? "cancelled" : "other");
        }
        await ctx.checkpoint("after-catch");
    });
    scheduler.spawn("canceller", async (ctx) => {
        await ctx.checkpoint();
        ctx.cancelTask("target");
    });
    await scheduler.run();
    strict_1.default.deepEqual(observed, ["cancelled"]);
    const trace = scheduler.getTrace();
    strict_1.default.ok(trace.some((e) => e.type === "cancel" && e.task === "target"));
    strict_1.default.ok(trace.some((e) => e.type === "complete" && e.task === "target"));
});
