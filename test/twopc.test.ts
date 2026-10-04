import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../src/checker.js";
import { Coordinator } from "../src/coordinator.js";
import { CrashFault, CrashInjector } from "../src/fault.js";
import { Participant } from "../src/participant.js";
import { runScenario } from "../src/simulator.js";
import { Wal } from "../src/wal.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "twopc-"));
}

const ALL_YES = { p1: "YES", p2: "YES", p3: "YES" } as const;
const ONE_NO = { p1: "YES", p2: "NO", p3: "YES" } as const;

test("commit: all participants vote YES, no crash", () => {
  const result = runScenario({ dir: tempDir(), votes: { ...ALL_YES } });
  assert.equal(result.decision, "COMMIT");
  assert.equal(result.crashes.length, 0);
  assert.ok(result.checker.ok, result.checker.violations.join("; "));
});

test("abort: one participant votes NO, no crash", () => {
  const result = runScenario({ dir: tempDir(), votes: { ...ONE_NO } });
  assert.equal(result.decision, "ABORT");
  assert.ok(result.checker.ok, result.checker.violations.join("; "));
});

test("recovery: crash at every persistence point (commit path)", () => {
  const baseline = runScenario({ dir: tempDir(), votes: { ...ALL_YES } });
  const points = [...new Set(baseline.checkpoints)];
  assert.ok(points.length >= 10, "expected many persistence points, got " + points.length);
  for (const point of points) {
    const result = runScenario({ dir: tempDir(), votes: { ...ALL_YES }, crashAt: [point] });
    assert.equal(result.decision, "COMMIT", "crash at " + point);
    assert.deepEqual(result.crashes, [point]);
    assert.ok(result.checker.ok, "crash at " + point + ": " + result.checker.violations.join("; "));
  }
});

test("recovery: crash at every persistence point (abort path)", () => {
  const baseline = runScenario({ dir: tempDir(), votes: { ...ONE_NO } });
  const points = [...new Set(baseline.checkpoints)];
  for (const point of points) {
    const result = runScenario({ dir: tempDir(), votes: { ...ONE_NO }, crashAt: [point] });
    assert.equal(result.decision, "ABORT", "crash at " + point);
    assert.ok(result.checker.ok, "crash at " + point + ": " + result.checker.violations.join("; "));
  }
});

test("recovery: repeated crashes at two different points in one run", () => {
  const result = runScenario({
    dir: tempDir(),
    votes: { ...ALL_YES },
    crashAt: ["coordinator:vote:p2", "coordinator:notify:p1"],
  });
  assert.equal(result.decision, "COMMIT");
  assert.deepEqual(result.crashes, ["coordinator:vote:p2", "coordinator:notify:p1"]);
  assert.ok(result.checker.ok, result.checker.violations.join("; "));
});

test("idempotency: duplicate prepare returns persisted vote, logs it once", () => {
  const dir = tempDir();
  const file = join(dir, "p.log");
  const p = new Participant("p1", file, () => "YES");
  assert.equal(p.prepare("txn-1"), "YES");
  // Even a contradictory script cannot change the persisted vote.
  const restarted = new Participant("p1", file, () => "NO");
  assert.equal(restarted.prepare("txn-1"), "YES");
  assert.equal(restarted.prepare("txn-1"), "YES");
  const votes = new Wal(file).readAll().filter((r) => r.type === "VOTE");
  assert.equal(votes.length, 1);
});

test("idempotency: duplicate decision delivery logged once; conflict rejected", () => {
  const dir = tempDir();
  const file = join(dir, "p.log");
  const p = new Participant("p1", file, () => "YES");
  p.prepare("txn-1");
  p.decide("txn-1", "COMMIT");
  p.decide("txn-1", "COMMIT"); // duplicate delivery: no-op
  assert.throws(() => p.decide("txn-1", "ABORT"), /conflicting decision/);
  const decisions = new Wal(file).readAll().filter((r) => r.type === "DECISION");
  assert.equal(decisions.length, 1);
});

test("idempotency: coordinator log holds one VOTE record per participant after crash", () => {
  const dir = tempDir();
  const result = runScenario({
    dir,
    votes: { ...ALL_YES },
    crashAt: ["coordinator:vote:p2"],
  });
  assert.equal(result.decision, "COMMIT");
  const votes = new Wal(join(dir, "coordinator.log")).readAll().filter((r) => r.type === "VOTE");
  assert.equal(votes.length, 3);
  assert.deepEqual([...new Set(votes.map((r) => r.participant))].sort(), ["p1", "p2", "p3"]);
});

test("no fake rollback: crash after COMMIT record resumes as COMMIT", () => {
  const dir = tempDir();
  const injector = new CrashInjector(["coordinator:decision"]);
  const mkParticipants = (inj: CrashInjector) =>
    Object.entries(ALL_YES).map(
      ([id, vote]) => new Participant(id, join(dir, "participant-" + id + ".log"), () => vote as "YES", inj),
    );

  // First incarnation: persists DECISION=COMMIT, then dies before notifying anyone.
  const first = new Coordinator(new Wal(join(dir, "coordinator.log")), injector);
  assert.throws(() => first.run("txn-1", mkParticipants(injector)), CrashFault);

  // The decision is durable; participants are blocked, not aborted.
  const coordLog = new Wal(join(dir, "coordinator.log")).readAll();
  assert.ok(coordLog.some((r) => r.type === "DECISION" && r.decision === "COMMIT"));
  for (const p of mkParticipants(new CrashInjector())) {
    assert.equal(p.status("txn-1"), "IN_DOUBT", p.id + " must not masquerade as rollback");
  }

  // Restart: a fresh coordinator follows only the records and finishes COMMIT.
  const second = new Coordinator(new Wal(join(dir, "coordinator.log")), new CrashInjector());
  assert.equal(second.run("txn-1", mkParticipants(new CrashInjector())), "COMMIT");
  for (const p of mkParticipants(new CrashInjector())) {
    assert.equal(p.status("txn-1"), "COMMITTED");
  }
});

test("honesty: in-doubt participant reports IN_DOUBT, never ABORTED", () => {
  const dir = tempDir();
  const p = new Participant("p1", join(dir, "p1.log"), () => "YES");
  assert.equal(p.status("txn-1"), "NOT_INVOLVED");
  p.prepare("txn-1");
  assert.equal(p.status("txn-1"), "IN_DOUBT");
  p.decide("txn-1", "COMMIT");
  assert.equal(p.status("txn-1"), "COMMITTED");
});

test("checker: independent verification catches divergent decisions", () => {
  const dir = tempDir();
  const coordLog = join(dir, "coordinator.log");
  const p1Log = join(dir, "participant-p1.log");
  const p2Log = join(dir, "participant-p2.log");
  writeFileSync(coordLog, JSON.stringify({ seq: 0, type: "DECISION", txnId: "txn-1", decision: "COMMIT" }) + "\n");
  writeFileSync(p1Log, JSON.stringify({ seq: 0, type: "DECISION", txnId: "txn-1", decision: "COMMIT" }) + "\n");
  writeFileSync(p2Log, JSON.stringify({ seq: 0, type: "DECISION", txnId: "txn-1", decision: "ABORT" }) + "\n");
  const report = check({ coordinatorLog: coordLog, participantLogs: { p1: p1Log, p2: p2Log } });
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.includes("disagree")), report.violations.join("; "));
});

test("checker: commit without unanimous YES votes is rejected", () => {
  const dir = tempDir();
  const coordLog = join(dir, "coordinator.log");
  const p1Log = join(dir, "participant-p1.log");
  const p2Log = join(dir, "participant-p2.log");
  writeFileSync(coordLog, JSON.stringify({ seq: 0, type: "DECISION", txnId: "txn-1", decision: "COMMIT" }) + "\n");
  writeFileSync(p1Log, JSON.stringify({ seq: 0, type: "VOTE", txnId: "txn-1", vote: "YES" }) + "\n");
  writeFileSync(p2Log, JSON.stringify({ seq: 0, type: "VOTE", txnId: "txn-1", vote: "NO" }) + "\n");
  const report = check({ coordinatorLog: coordLog, participantLogs: { p1: p1Log, p2: p2Log } });
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((v) => v.includes("requires YES")), report.violations.join("; "));
});

test("cleanup: temp dirs removable", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "x"), "y");
  rmSync(dir, { recursive: true, force: true });
  assert.ok(true);
});
