import { test } from "node:test";
import { equal, deepEqual, ok, throws } from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { Participant } from "../src/participant.js";
import { Hub } from "../src/hub.js";
import { check } from "../src/checker.js";
import { CrashFault } from "../src/types.js";
import type { Vote } from "../src/types.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "tpc-"));
}

interface Cluster {
  dir: string;
  hub: Hub;
  coordinator: Coordinator;
  participants: Map<string, Participant>;
}

/** Build a cluster whose participants vote according to `votes`. */
function makeCluster(votes: Record<string, Vote>): Cluster {
  const dir = freshDir();
  const hub = new Hub();
  const participants = new Map<string, Participant>();
  for (const [id, vote] of Object.entries(votes)) {
    const participant = new Participant(dir, id, vote);
    participants.set(id, participant);
    hub.register(participant);
  }
  const coordinator = new Coordinator(dir, hub);
  return { dir, hub, coordinator, participants };
}

function recordsOf(coordinator: Coordinator, kind: string) {
  return coordinator.records().filter((record) => record.kind === kind);
}

test("happy path: all YES votes commit everywhere", () => {
  const c = makeCluster({ a: "YES", b: "YES", p3: "YES" });
  const status = c.coordinator.run("tx1", ["a", "b", "p3"]);
  equal(status, "COMMIT");
  const result = check(c.dir, true);
  deepEqual(result.violations, []);
});

test("a single NO vote aborts everywhere", () => {
  const c = makeCluster({ a: "YES", b: "NO", p3: "YES" });
  const status = c.coordinator.run("tx1", ["a", "b", "p3"]);
  equal(status, "ABORT");
  const result = check(c.dir, true);
  deepEqual(result.violations, []);
});

test("duplicate deliveries are idempotent on participants", () => {
  const c = makeCluster({ a: "YES", b: "YES" });
  c.hub.duplicates = 2; // every PREPARE and DECISION delivered 3 times
  const status = c.coordinator.run("tx1", ["a", "b"]);
  equal(status, "COMMIT");
  for (const participant of c.participants.values()) {
    const records = participant.records();
    equal(records.filter((r) => r.kind === "PREPARED").length, 1);
    equal(records.filter((r) => r.kind === "COMMITTED").length, 1);
  }
  // Coordinator records each vote once even if asked repeatedly.
  equal(recordsOf(c.coordinator, "VOTE").length, 2);
  deepEqual(check(c.dir, true).violations, []);
});

test("coordinator crash after DECISION COMMIT: restart resumes from the log", () => {
  const c = makeCluster({ a: "YES", b: "YES" });
  c.coordinator.onAppend = (record) => {
    if (record.kind === "DECISION") throw new CrashFault("crash after decision");
  };
  throws(() => c.coordinator.run("tx1", ["a", "b"]), CrashFault);

  // Restart: a brand-new coordinator instance over the same directory.
  const revived = new Coordinator(c.dir, c.hub);
  equal(revived.status("tx1"), "COMMIT"); // decision survived the crash
  revived.recover(); // re-deliver the recorded decision

  for (const participant of c.participants.values()) {
    const finals = participant.records().filter((r) => r.kind === "COMMITTED");
    equal(finals.length, 1);
  }
  deepEqual(check(c.dir, true).violations, []);
});

test("coordinator crash mid phase 1: restart re-collects votes idempotently", () => {
  const c = makeCluster({ a: "YES", b: "YES", p3: "YES" });
  let appends = 0;
  c.coordinator.onAppend = () => {
    appends += 1;
    if (appends === 2) throw new CrashFault("crash after first VOTE record");
  };
  throws(() => c.coordinator.run("tx1", ["a", "b", "p3"]), CrashFault);

  const revived = new Coordinator(c.dir, c.hub);
  equal(revived.status("tx1"), "PENDING"); // no decision was ever recorded
  revived.recover();
  equal(revived.status("tx1"), "COMMIT");

  // Participant 'a' was prepared before the crash and re-asked after it:
  // its log must still contain exactly one PREPARED record.
  const a = c.participants.get("a")!;
  equal(a.records().filter((r) => r.kind === "PREPARED").length, 1);
  equal(recordsOf(revived, "VOTE").length, 3);
  deepEqual(check(c.dir, true).violations, []);
});

test("undecided transaction is never masqueraded as a rollback", () => {
  const c = makeCluster({ a: "YES", b: "YES", c: "YES" });
  c.hub.setDown("c", true); // c unreachable before it ever votes

  const status = c.coordinator.run("tx1", ["a", "b", "c"]);
  equal(status, "PENDING");

  // Coordinator crashes and restarts while c is still down.
  const revived = new Coordinator(c.dir, c.hub);
  revived.recover();
  equal(revived.status("tx1"), "PENDING");

  // No DECISION record may exist, and nobody may have aborted.
  equal(recordsOf(revived, "DECISION").length, 0);
  const mid = check(c.dir, false);
  deepEqual(mid.violations, []);
  deepEqual(mid.pending, ["tx1"]);

  // c comes back: the transaction completes as COMMIT, not a fabricated abort.
  c.hub.setDown("c", false);
  revived.recover();
  equal(revived.status("tx1"), "COMMIT");
  deepEqual(check(c.dir, true).violations, []);
});

test("crash at every durable point still converges consistently", () => {
  // A clean run appends BEGIN + 3 VOTEs + DECISION = 5 coordinator records.
  const clean = makeCluster({ a: "YES", b: "YES", p3: "YES" });
  clean.coordinator.run("tx1", ["a", "b", "p3"]);
  const totalAppends = clean.coordinator.records().length;
  equal(totalAppends, 5);

  for (let crashAt = 1; crashAt <= totalAppends; crashAt++) {
    const c = makeCluster({ a: "YES", b: "YES", p3: "YES" });
    let appends = 0;
    c.coordinator.onAppend = () => {
      appends += 1;
      if (appends === crashAt) throw new CrashFault(`crash at append ${crashAt}`);
    };
    throws(() => c.coordinator.run("tx1", ["a", "b", "p3"]), CrashFault);

    const revived = new Coordinator(c.dir, c.hub);
    revived.recover();
    equal(revived.status("tx1"), "COMMIT", `crash at append ${crashAt}`);
    deepEqual(check(c.dir, true).violations, [], `crash at append ${crashAt}`);
  }
});

test("participant crash after PREPARED: restart replays its recorded vote", () => {
  const dir = freshDir();
  const hub = new Hub();
  const flaky = new Participant(dir, "flaky", "YES");
  flaky.onAppend = (record) => {
    if (record.kind === "PREPARED") throw new CrashFault("crash after PREPARED");
  };
  hub.register(flaky);
  hub.register(new Participant(dir, "steady", "YES"));
  const coordinator = new Coordinator(dir, hub);

  throws(() => coordinator.run("tx1", ["flaky", "steady"]), CrashFault);
  equal(coordinator.status("tx1"), "PENDING"); // flaky's YES was lost with the crash

  // Restart the crashed participant from its own log and let the
  // coordinator resume: the recorded YES vote is replayed, not re-decided.
  hub.register(new Participant(dir, "flaky", "YES"));
  coordinator.recover();
  equal(coordinator.status("tx1"), "COMMIT");

  const log = new Participant(dir, "flaky", "YES").records();
  equal(log.filter((r) => r.kind === "PREPARED").length, 1);
  equal(log.filter((r) => r.kind === "COMMITTED").length, 1);
  deepEqual(check(dir, true).violations, []);
});

test("independent checker detects a fabricated rollback", () => {
  const dir = freshDir();
  writeFileSync(
    join(dir, "coordinator.log"),
    [
      { kind: "BEGIN", txId: "tx1", participants: ["a"] },
      { kind: "VOTE", txId: "tx1", from: "a", vote: "YES" },
      { kind: "DECISION", txId: "tx1", decision: "ABORT" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "participant-a.log"),
    JSON.stringify({ kind: "PREPARED", txId: "tx1" }) + "\n",
  );
  const result = check(dir, false);
  ok(result.violations.some((v) => v.includes("fabricated rollback")));
});

test("independent checker detects divergent participant outcomes", () => {
  const dir = freshDir();
  writeFileSync(
    join(dir, "coordinator.log"),
    [
      { kind: "BEGIN", txId: "tx1", participants: ["a", "b"] },
      { kind: "VOTE", txId: "tx1", from: "a", vote: "YES" },
      { kind: "VOTE", txId: "tx1", from: "b", vote: "YES" },
      { kind: "DECISION", txId: "tx1", decision: "COMMIT" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "participant-a.log"),
    [
      { kind: "PREPARED", txId: "tx1" },
      { kind: "COMMITTED", txId: "tx1" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "participant-b.log"),
    [
      { kind: "PREPARED", txId: "tx1" },
      { kind: "ABORTED", txId: "tx1", cause: "DECISION" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  const result = check(dir, false);
  ok(result.violations.some((v) => v.includes("divergent outcomes")));
  ok(result.violations.some((v) => v.includes("no DECISION ABORT")));
});
