import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Machine, simulate, validateMachine } from "../src/fsm.js";
import { minimize, NotFailingError } from "../src/reduce.js";
import { finalLine, headerLine, judgmentLine, replayTrace } from "../src/trace.js";

const counter = JSON.parse(readFileSync("examples/counter.json", "utf8")) as {
  machine: Machine;
  events: string[];
};
const guard = JSON.parse(readFileSync("examples/guard.json", "utf8")) as {
  machine: Machine;
  events: string[];
};

function assertOneMinimal(machine: Machine, reduced: string[]): void {
  assert.equal(simulate(machine, reduced).verdict, "fail", "reduced sequence must still fail");
  for (let i = 0; i < reduced.length; i++) {
    const candidate = [...reduced.slice(0, i), ...reduced.slice(i + 1)];
    assert.notEqual(
      simulate(machine, candidate).verdict,
      "fail",
      `deleting event ${i} (${reduced[i]}) must not fail`,
    );
  }
}

test("simulate classifies fail / pass / invalid", () => {
  assert.equal(simulate(counter.machine, ["tick", "tick", "tick"]).verdict, "fail");
  assert.equal(simulate(counter.machine, ["tick", "reset", "tick"]).verdict, "pass");
  const invalid = simulate(guard.machine, ["fire"]);
  assert.equal(invalid.verdict, "invalid");
  assert.equal(invalid.invalidAt, 0);
  assert.equal(invalid.invalidEvent, "fire");
});

test("validateMachine rejects dangling references", () => {
  const broken: Machine = {
    states: ["a"],
    initial: "nope",
    failureStates: ["ghost"],
    transitions: { a: { e: "nowhere" }, stranger: {} },
  };
  const errors = validateMachine(broken);
  assert.equal(errors.length, 4);
  assert.equal(validateMachine(counter.machine).length, 0);
});

test("counter example reduces to [tick tick tick] and is 1-minimal", () => {
  const { reduced, oneMinimalChecks } = minimize(counter.machine, counter.events);
  assert.deepEqual(reduced, ["tick", "tick", "tick"]);
  assert.equal(oneMinimalChecks.length, 3);
  assertOneMinimal(counter.machine, reduced);
});

test("guard example: invalid histories are never accepted as failures", () => {
  const { reduced, judgments } = minimize(guard.machine, guard.events);
  assert.deepEqual(reduced, ["arm", "fire"]);
  const invalidJudgments = judgments.filter((j) => j.verdict === "invalid");
  assert.ok(invalidJudgments.length > 0, "expected some invalid candidates to be probed");
  assert.ok(
    invalidJudgments.every((j) => !j.accepted),
    "an invalid history must never be accepted",
  );
  assertOneMinimal(guard.machine, reduced);
});

test("non-failing input is rejected, not minimized", () => {
  assert.throws(
    () => minimize(counter.machine, ["tick", "reset", "tick"]),
    (err: unknown) => err instanceof NotFailingError && err.verdict === "pass",
  );
  assert.throws(
    () => minimize(guard.machine, ["fire", "arm"]),
    (err: unknown) => err instanceof NotFailingError && err.verdict === "invalid",
  );
});

test("reduction is deterministic across runs", () => {
  const first = minimize(counter.machine, counter.events);
  const second = minimize(counter.machine, counter.events);
  assert.deepEqual(first.judgments, second.judgments);
  assert.deepEqual(first.reduced, second.reduced);
});

test("trace replay reproduces every judgment and confirms 1-minimality", () => {
  const lines: string[] = [headerLine(counter.machine, counter.events)];
  const { reduced, judgments } = minimize(counter.machine, counter.events, (j) =>
    lines.push(judgmentLine(j)),
  );
  lines.push(
    finalLine({ kind: "final", reduced, oneMinimal: true, judgmentCount: judgments.length }),
  );
  const report = replayTrace(lines.join("\n") + "\n");
  assert.equal(report.ok, true, report.mismatches.join("; "));
  assert.equal(report.judgmentCount, judgments.length);
  assert.equal(report.oneMinimal, true);
  assert.deepEqual(report.reduced, reduced);
});

test("replay detects a tampered verdict", () => {
  const lines: string[] = [headerLine(counter.machine, counter.events)];
  const { reduced, judgments } = minimize(counter.machine, counter.events, (j) =>
    lines.push(judgmentLine(j)),
  );
  lines.push(
    finalLine({ kind: "final", reduced, oneMinimal: true, judgmentCount: judgments.length }),
  );
  const tampered = JSON.parse(lines[1]) as { verdict: string };
  tampered.verdict = tampered.verdict === "fail" ? "pass" : "fail";
  lines[1] = JSON.stringify(tampered);
  const report = replayTrace(lines.join("\n") + "\n");
  assert.equal(report.ok, false);
  assert.equal(report.mismatches.length, 1);
});
