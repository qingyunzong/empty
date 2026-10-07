import test from "node:test";
import assert from "node:assert/strict";
import { ProgramDef, Simulator, runProgram, validateProgram } from "../src/simulator";

const counterThread = (amount: number) => [
  { op: "read" as const, var: "x", dst: "r" },
  { op: "add" as const, dst: "r", value: amount },
  { op: "write" as const, var: "x", src: "r" },
];

const raceProgram: ProgramDef = {
  shared: { x: 0 },
  threads: [counterThread(1), counterThread(1)],
};

const mutexProgram: ProgramDef = {
  shared: { x: 0 },
  threads: [
    [
      { op: "lock", mutex: "m" },
      ...counterThread(1),
      { op: "unlock", mutex: "m" },
    ],
    [
      { op: "lock", mutex: "m" },
      ...counterThread(1),
      { op: "unlock", mutex: "m" },
    ],
  ],
};

const deadlockProgram: ProgramDef = {
  shared: {},
  threads: [
    [
      { op: "lock", mutex: "a" },
      { op: "lock", mutex: "b" },
      { op: "unlock", mutex: "b" },
      { op: "unlock", mutex: "a" },
    ],
    [
      { op: "lock", mutex: "b" },
      { op: "lock", mutex: "a" },
      { op: "unlock", mutex: "a" },
      { op: "unlock", mutex: "b" },
    ],
  ],
};

test("run executes a schedule and reports final shared state", () => {
  const result = runProgram(raceProgram, [0, 0, 0, 1, 1, 1]);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.final.shared, { x: 2 });
  assert.equal(result.trace.length, 7);
  assert.equal(result.final.threads[0].status, "done");
});

test("lost update is visible under an interleaved schedule", () => {
  const result = runProgram(raceProgram, [0, 1, 0, 1, 0, 1]);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.final.shared, { x: 1 });
});

test("lock blocks the other thread and rejects invalid schedules", () => {
  const sim = new Simulator(mutexProgram);
  sim.step(0);
  assert.equal(sim.isRunnable(1), false);
  assert.equal(sim.status(1), "blocked");
  assert.throws(() => sim.step(1), /blocked on mutex "m"/);
  assert.throws(() => sim.run([1]), /not runnable/);
});

test("mutex serializes the counter increments", () => {
  const result = runProgram(mutexProgram, [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.final.shared, { x: 2 });
  assert.deepEqual(result.final.locks, { m: null });
});

test("deadlock is reported with the lock table intact", () => {
  const result = runProgram(deadlockProgram, [0, 1]);
  assert.equal(result.outcome, "deadlock");
  assert.equal(result.final.deadlocked, true);
  assert.deepEqual(result.final.locks, { a: 0, b: 1 });
  assert.equal(result.final.threads[0].status, "blocked");
  assert.equal(result.final.threads[1].status, "blocked");
});

test("unlock by a non-holder throws", () => {
  const program: ProgramDef = {
    shared: {},
    threads: [[{ op: "unlock", mutex: "m" }]],
  };
  assert.throws(() => runProgram(program, [0]), /cannot unlock mutex "m"/);
});

test("re-locking a held mutex throws", () => {
  const program: ProgramDef = {
    shared: {},
    threads: [[{ op: "lock", mutex: "m" }, { op: "lock", mutex: "m" }]],
  };
  assert.throws(() => runProgram(program, [0, 0]), /re-locks mutex "m"/);
});

test("jnz loops until the counter register hits zero", () => {
  const program: ProgramDef = {
    shared: { x: 0 },
    threads: [
      [
        { op: "set", dst: "n", value: 3 },
        { op: "read", var: "x", dst: "r" },
        { op: "add", dst: "r", value: 1 },
        { op: "write", var: "x", src: "r" },
        { op: "add", dst: "n", value: -1 },
        { op: "jnz", reg: "n", target: 1 },
      ],
    ],
  };
  const result = runProgram(program, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(result.outcome, "done");
  assert.deepEqual(result.final.shared, { x: 3 });
});

test("incomplete schedule yields an incomplete outcome", () => {
  const result = runProgram(raceProgram, [0, 1]);
  assert.equal(result.outcome, "incomplete");
  assert.equal(result.final.allDone, false);
});

test("validateProgram accepts a well-formed program", () => {
  const program = validateProgram({
    shared: { x: 0 },
    threads: [[{ op: "read", var: "x", dst: "r" }]],
  });
  assert.equal(program.threads.length, 1);
});

test("validateProgram rejects more than 3 threads", () => {
  assert.throws(
    () => validateProgram({ shared: {}, threads: [[], [], [], []] }),
    /1\.\.3 threads/
  );
});

test("validateProgram rejects undeclared shared variables", () => {
  assert.throws(
    () => validateProgram({ shared: {}, threads: [[{ op: "read", var: "y", dst: "r" }]] }),
    /not declared/
  );
});

test("validateProgram rejects out-of-range branch targets", () => {
  assert.throws(
    () =>
      validateProgram({
        shared: {},
        threads: [[{ op: "jnz", reg: "r", target: 5 }]],
      }),
    /target/
  );
});
