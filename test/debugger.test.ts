import test from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { Debugger, Instruction, VMState, stateEquals } from "../src/index.js";

const sumProgram: Instruction[] = [
  { op: "const", dst: 0, value: 0 }, //  0: acc = 0
  { op: "const", dst: 3, value: 1 }, //  1: one = 1
  { op: "const", dst: 1, value: 3 }, //  2: count = 3
  { op: "in", dst: 2 },              //  3: loop: read x
  { op: "add", dst: 0, a: 0, b: 2 }, //  4: acc += x
  { op: "sub", dst: 1, a: 1, b: 3 }, //  5: count -= 1
  { op: "jz", cond: 1, target: 8 },  //  6: if count == 0 goto done
  { op: "jmp", target: 3 },          //  7: goto loop
  { op: "store", addr: 0, src: 0 },  //  8: heap[0] = acc
  { op: "out", src: 0 },             //  9: output acc
  { op: "halt" },                    // 10: halt
];

const linearProgram: Instruction[] = [
  { op: "const", dst: 0, value: 5 },
  { op: "const", dst: 1, value: 7 },
  { op: "add", dst: 0, a: 0, b: 1 },
  { op: "store", addr: 0, src: 0 },
  { op: "halt" },
];

function runSum(inputs: number[], snapshotInterval = 4): Debugger {
  const dbg = new Debugger(sumProgram, { snapshotInterval });
  for (const value of inputs) dbg.provideInput(value);
  equal(dbg.run(), "halt");
  return dbg;
}

test("records instruction execution as ordered exec events", () => {
  const dbg = new Debugger(linearProgram);
  equal(dbg.run(), "halt");
  const events = dbg.events;
  equal(events.length, 5);
  deepEqual(
    events.map((e) => e.seq),
    [1, 2, 3, 4, 5],
  );
  ok(events.every((e) => e.kind === "exec"));
  deepEqual(
    events.map((e) => (e.kind === "exec" ? e.pc : -1)),
    [0, 1, 2, 3, 4],
  );
  equal(dbg.state.halted, true);
  equal(dbg.state.regs[0], 12);
  equal(dbg.state.heap.get(0), 12);
});

test("records external inputs and replays them without forking", () => {
  const dbg = runSum([10, 20, 30]);
  deepEqual(dbg.state.outputs, [60]);
  equal(dbg.state.heap.get(0), 60);
  const inputs = dbg.events.filter((e) => e.kind === "input");
  deepEqual(
    inputs.map((e) => (e.kind === "input" ? e.value : -1)),
    [10, 20, 30],
  );
  const eventCount = dbg.events.length;

  dbg.seekTo(0);
  equal(dbg.run(), "halt");
  deepEqual(dbg.state.outputs, [60]);
  equal(dbg.events.length, eventCount, "replay must not append new events");
  deepEqual(dbg.getVersionIds(), [0], "replay with recorded inputs must not fork");
});

test("seekTo restores registers and heap at any event seq", () => {
  const dbg = runSum([10, 20, 30]);
  const storeEvent = dbg.events.find((e) => e.kind === "exec" && e.op === "store")!;
  dbg.seekTo(storeEvent.seq);
  equal(dbg.state.regs[0], 60);
  equal(dbg.state.heap.get(0), 60);

  const firstInput = dbg.events.find((e) => e.kind === "input")!;
  dbg.seekTo(firstInput.seq);
  equal(dbg.state.regs[2], 10);
  equal(dbg.state.heap.size, 0);

  dbg.seekTo(0);
  deepEqual(dbg.state.regs, [0, 0, 0, 0, 0, 0, 0, 0]);
  equal(dbg.state.pc, 0);

  throws(() => dbg.seekTo(dbg.tipOf() + 1), /cannot seek/);
});

test("seekTo matches an independent step-by-step replay for every seq", () => {
  const recorded = runSum([7, 8, 9], 3);
  const stepped = new Debugger(sumProgram);
  for (const value of [7, 8, 9]) stepped.provideInput(value);
  const states = new Map<number, VMState>();
  for (;;) {
    states.set(stepped.seq, stepped.state);
    const result = stepped.step();
    if (result !== "ok") break;
  }
  states.set(stepped.seq, stepped.state);
  ok(states.size > 20);
  for (const [seq, expected] of states) {
    recorded.seekTo(seq);
    ok(stateEquals(recorded.state, expected), `state mismatch at seq ${seq}`);
  }
});

test("a new input while recorded future exists forks a new version", () => {
  const dbg = runSum([10, 20, 30]);
  const originalTip = dbg.tipOf();
  const thirdInput = dbg.events.filter((e) => e.kind === "input")[2]!;

  dbg.seekTo(thirdInput.seq - 1);
  dbg.provideInput(99);
  equal(dbg.run(), "halt");

  deepEqual(dbg.getVersionIds(), [0, 1]);
  equal(dbg.currentVersionId, 1);
  const child = dbg.getVersion(1)!;
  equal(child.parentId, 0);
  equal(child.forkSeq, thirdInput.seq - 1);
  deepEqual(dbg.state.outputs, [129]);
  equal(dbg.state.heap.get(0), 129);

  const original = dbg.getVersion(0)!;
  equal(original.forkSeq + original.events.length, originalTip, "parent timeline stays intact");

  dbg.checkout(0);
  equal(dbg.run(), "halt");
  deepEqual(dbg.state.outputs, [60], "original version still replays recorded inputs");
});

test("new input at the live tip extends the version without forking", () => {
  const dbg = new Debugger(sumProgram);
  dbg.provideInput(1);
  equal(dbg.run(), "needsInput");
  dbg.provideInput(2);
  equal(dbg.run(), "needsInput");
  dbg.provideInput(3);
  equal(dbg.run(), "halt");
  deepEqual(dbg.getVersionIds(), [0]);
  deepEqual(dbg.state.outputs, [6]);
});

test("breakpoints pause execution without producing events", () => {
  const dbg = new Debugger(linearProgram);
  equal(dbg.run({ breakpoints: [2] }), "breakpoint");
  equal(dbg.seq, 2, "only the two executed instructions count as events");
  equal(dbg.events.length, 2);
  equal(dbg.state.pc, 2);

  equal(dbg.run(), "halt", "resuming runs past the same breakpoint");
  equal(dbg.seq, 5);
  equal(dbg.state.regs[0], 12);

  const atEntry = new Debugger(linearProgram);
  equal(atEntry.run({ breakpoints: [0] }), "breakpoint");
  equal(atEntry.seq, 0, "breakpoint before any execution emits no events");
});

test("verify replays step-by-step and checks full state snapshots", () => {
  const dbg = runSum([10, 20, 30], 2);
  const result = dbg.verify();
  ok(result.ok, `verify failed: ${result.problems.join("; ")}`);
  const snapshotCount = dbg.getVersion(0)!.snapshots.size;
  ok(snapshotCount >= 5);
  equal(result.snapshotsChecked, snapshotCount, "every recorded snapshot is checked");
  equal(result.mismatches.length, 0);
});

test("verify detects a corrupted snapshot", () => {
  const dbg = runSum([10, 20, 30], 2);
  const root = dbg.getVersion(0)!;
  const target = [...root.snapshots.keys()].find((s) => s > 0)!;
  root.snapshots.get(target)!.regs[0] = 424242;
  const result = dbg.verify();
  equal(result.ok, false);
  deepEqual(
    result.mismatches.map((m) => m.seq),
    [target],
  );
  equal(result.mismatches[0]!.expected.regs[0], 424242);
  equal(result.mismatches[0]!.actual.regs[0] !== 424242, true);
});

test("verify covers forked versions through the ancestor chain", () => {
  const dbg = runSum([10, 20, 30], 2);
  const inputs = dbg.events.filter((e) => e.kind === "input");
  dbg.seekTo(inputs[1]!.seq - 1);
  dbg.provideInput(50);
  dbg.provideInput(60);
  equal(dbg.run(), "halt");
  deepEqual(dbg.state.outputs, [120]);
  ok(dbg.verify().ok, "forked version verifies against inherited + own snapshots");
  ok(dbg.verify(0).ok, "original version still verifies");
});

test("step executes exactly one event and reports needsInput", () => {
  const dbg = new Debugger(sumProgram);
  equal(dbg.step(), "ok");
  equal(dbg.step(), "ok");
  equal(dbg.step(), "ok");
  equal(dbg.seq, 3);
  equal(dbg.step(), "needsInput", "in pauses when no input is available");
  equal(dbg.seq, 3, "needsInput does not consume an event");
  dbg.provideInput(4);
  equal(dbg.step(), "ok");
  equal(dbg.state.regs[2], 4);
  const inputEvents = dbg.events.filter((e) => e.kind === "input");
  equal(inputEvents.length, 1);
});
