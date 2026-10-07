import test from "node:test";
import assert from "node:assert/strict";
import { ProgramDef } from "../src/simulator";
import { MAX_EXPLORE_STEPS, explore, sequentialReference, verify } from "../src/explore";

const counterThread = [
  { op: "read" as const, var: "x", dst: "r" },
  { op: "add" as const, dst: "r", value: 1 },
  { op: "write" as const, var: "x", src: "r" },
];

const raceProgram: ProgramDef = {
  shared: { x: 0 },
  threads: [counterThread, counterThread],
};

const mutexProgram: ProgramDef = {
  shared: { x: 0 },
  threads: [
    [{ op: "lock", mutex: "m" }, ...counterThread, { op: "unlock", mutex: "m" }],
    [{ op: "lock", mutex: "m" }, ...counterThread, { op: "unlock", mutex: "m" }],
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

const sharedValues = (result: ReturnType<typeof explore>) =>
  result.resultSet.map((entry) => entry.shared.x).sort((a, b) => a - b);

test("explore finds both outcomes of the racy counter", () => {
  const result = explore(raceProgram);
  assert.deepEqual(sharedValues(result), [1, 2]);
  assert.equal(result.deadlocks.length, 0);
  assert.equal(result.truncated, false);
});

test("explore of the mutex version yields a single result", () => {
  const result = explore(mutexProgram);
  assert.deepEqual(sharedValues(result), [2]);
  assert.equal(result.resultSet[0].locks.m, null);
});

test("explore reports the deadlock state with its lock table", () => {
  const result = explore(deadlockProgram);
  assert.equal(result.deadlocks.length, 1);
  assert.deepEqual(result.deadlocks[0].snapshot.locks, { a: 0, b: 1 });
  assert.deepEqual([...result.deadlocks[0].schedule].sort(), [0, 1]);
  assert.ok(result.resultSet.length > 0);
});

test("explore respects the step bound and records cutoffs", () => {
  const spinner: ProgramDef = {
    shared: {},
    threads: [
      [
        { op: "add", dst: "r", value: 1 },
        { op: "jnz", reg: "r", target: 0 },
      ],
    ],
  };
  const result = explore(spinner, { maxSteps: 5 });
  assert.equal(result.cutoffCount, 1);
  assert.equal(result.resultSet.length, 0);
  assert.equal(result.terminals.length, 0);
});

test("explore rejects maxSteps outside 1..20", () => {
  assert.throws(() => explore(raceProgram, { maxSteps: MAX_EXPLORE_STEPS + 1 }), /maxSteps/);
  assert.throws(() => explore(raceProgram, { maxSteps: 0 }), /maxSteps/);
});

test("sequential reference runs threads one after another", () => {
  const ref = sequentialReference(raceProgram);
  assert.equal(ref.outcome, "done");
  assert.deepEqual(ref.final.shared, { x: 2 });
});

test("verify passes for race, mutex and deadlock programs", () => {
  for (const program of [raceProgram, mutexProgram, deadlockProgram]) {
    const report = verify(program, explore(program));
    assert.ok(report.ok, JSON.stringify(report.checks, null, 2));
    assert.ok(report.checks.every((c) => c.status !== "fail"));
  }
});

test("verify skips the reference membership check when exploration is cut off", () => {
  const long: ProgramDef = {
    shared: { x: 0 },
    threads: [
      [
        { op: "set", dst: "n", value: 30 },
        { op: "add", dst: "n", value: -1 },
        { op: "jnz", reg: "n", target: 1 },
        { op: "write", var: "x", src: 1 },
      ],
    ],
  };
  const report = verify(long, explore(long, { maxSteps: 10 }));
  const ref = report.checks.find((c) => c.name === "sequential-reference");
  assert.equal(ref?.status, "skip");
  assert.ok(report.ok);
});
