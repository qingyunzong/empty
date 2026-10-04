import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFsm } from "../src/fsm.js";
import { replay, type Verdict } from "../src/oracle.js";
import { minimize, verifyOneMinimal } from "../src/minimize.js";

const fsm = parseFsm({
  initial: "idle",
  failureStates: ["error"],
  transitions: {
    idle: { open: "opened", noop: "idle" },
    opened: { read: "opened", lock: "locked", close: "idle", noop: "opened" },
    locked: { write: "error", unlock: "opened", noop: "locked" },
    error: { reset: "idle" },
  },
});

const oracle = (seq: readonly string[]): Verdict => replay(fsm, seq).verdict;

test("minimizes a noisy failing history to the essential trigger", () => {
  const input = ["noop", "open", "read", "lock", "noop", "write"];
  const result = minimize(input, oracle);
  assert.deepEqual(result, ["open", "lock", "write"]);
  assert.equal(replay(fsm, result).verdict, "fail");
});

test("result is 1-minimal: every single-event deletion stops failing", () => {
  const input = ["noop", "open", "read", "lock", "noop", "write"];
  const result = minimize(input, oracle);
  assert.deepEqual(verifyOneMinimal(result, oracle), []);

  // illegal histories produced by deletions count as "not failing"
  assert.equal(oracle(result.filter((_, i) => i !== 0)), "invalid"); // no open
  assert.equal(oracle(result.filter((_, i) => i !== 1)), "invalid"); // no lock
  assert.equal(oracle(result.filter((_, i) => i !== 2)), "pass"); // no write
});

test("an already 1-minimal input is returned unchanged", () => {
  const result = minimize(["open", "lock", "write"], oracle);
  assert.deepEqual(result, ["open", "lock", "write"]);
});

test("minimization never accepts an illegal history as a failure", () => {
  // Deleting the "open" block yields an illegal history; the minimizer
  // must keep enough events for the sequence to remain legal and failing.
  const input = ["open", "noop", "lock", "unlock", "lock", "write"];
  const result = minimize(input, oracle);
  assert.equal(replay(fsm, result).verdict, "fail");
  assert.deepEqual(verifyOneMinimal(result, oracle), []);
});

test("minimization is deterministic across runs", () => {
  const input = ["noop", "open", "read", "lock", "noop", "write"];
  const traceA: Verdict[] = [];
  const traceB: Verdict[] = [];
  const runA = minimize(input, (seq) => {
    const v = oracle(seq);
    traceA.push(v);
    return v;
  });
  const runB = minimize(input, (seq) => {
    const v = oracle(seq);
    traceB.push(v);
    return v;
  });
  assert.deepEqual(runA, runB);
  assert.deepEqual(traceA, traceB);
});
