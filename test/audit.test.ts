import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuditLog,
  evaluateArtifact,
  formatReport,
  hashSourceFiles,
  runAndRecord,
  TestRecord,
} from "../src/index";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const H1 = hashSourceFiles({ "a.ts": "export const x = 1;" });
const H2 = hashSourceFiles({ "a.ts": "export const x = 2;" });

function rec(partial: Partial<TestRecord> & Pick<TestRecord, "suite" | "sourceHash">): TestRecord {
  return {
    command: "npm test",
    exitCode: 0,
    recordedAt: "2026-10-07T00:00:00.000Z",
    ...partial,
  };
}

const REQUIRED = [
  { suite: "unit", command: "npm test" },
  { suite: "lint", command: "npm run lint" },
];

test("record binds source hash, command and actual exit code; invalid records rejected", () => {
  const log = new AuditLog();
  const r = rec({ suite: "unit", sourceHash: H1, exitCode: 3, command: "make check" });
  log.add(r);
  assert.equal(log.all().length, 1);
  assert.throws(() => log.add(rec({ suite: "x", sourceHash: "deadbeef" })), /sha256/);
  assert.throws(() => log.add(rec({ suite: "x", sourceHash: H1, exitCode: 0.5 })), /integer/);
  assert.throws(() => log.add(rec({ suite: "", sourceHash: H1 })), /suite/);
});

test("only same-hash records are admissible for the current artifact", () => {
  const log = new AuditLog();
  log.add(rec({ suite: "unit", sourceHash: H1 }));
  log.add(rec({ suite: "unit", sourceHash: H2, exitCode: 1 }));
  assert.equal(log.forArtifact(H1).length, 1);
  assert.equal(log.forArtifact(H2)[0].exitCode, 1);

  const report = evaluateArtifact(log, H2, [{ suite: "unit", command: "npm test" }]);
  assert.equal(report.verdict, "fail");
  assert.equal(report.applicable.length, 1);
  assert.equal(report.excludedStale.length, 1);
  assert.equal(report.excludedStale[0].record.sourceHash, H1);
});

test("old pass and new failure are never stitched together", () => {
  const log = new AuditLog();
  // unit passed on the OLD hash; lint only failed on the NEW hash.
  log.add(rec({ suite: "unit", sourceHash: H1, exitCode: 0 }));
  log.add(rec({ suite: "lint", command: "npm run lint", sourceHash: H2, exitCode: 1 }));

  // Judging the NEW artifact: fail from lint, and unit is MISSING (its old
  // pass must not be carried over).
  const now = evaluateArtifact(log, H2, REQUIRED);
  assert.equal(now.verdict, "fail");
  assert.deepEqual(
    now.missing.map((m) => m.suite),
    ["unit"],
  );
  assert.equal(now.failures[0].suite, "lint");

  // Judging the OLD artifact: unit passed but lint evidence is missing —
  // the new failure must not be stitched in either direction.
  const old = evaluateArtifact(log, H1, REQUIRED);
  assert.equal(old.verdict, "incomplete");
  assert.deepEqual(
    old.missing.map((m) => m.suite),
    ["lint"],
  );
  assert.equal(old.failures.length, 0);
});

test("missing evidence is reported per required suite+command", () => {
  const log = new AuditLog();
  log.add(rec({ suite: "unit", sourceHash: H1 }));
  const report = evaluateArtifact(log, H1, REQUIRED);
  assert.equal(report.verdict, "incomplete");
  assert.equal(report.missing.length, 1);
  assert.equal(report.missing[0].reason, "no-record-for-current-hash");
  assert.equal(report.missing[0].command, "npm run lint");
});

test("conflicting exit codes for the same hash+suite+command are reported", () => {
  const log = new AuditLog();
  log.add(rec({ suite: "unit", sourceHash: H1, exitCode: 0, recordedAt: "2026-10-07T00:00:00Z" }));
  log.add(rec({ suite: "unit", sourceHash: H1, exitCode: 1, recordedAt: "2026-10-07T01:00:00Z" }));
  log.add(rec({ suite: "lint", command: "npm run lint", sourceHash: H1 }));
  const report = evaluateArtifact(log, H1, REQUIRED);
  assert.equal(report.verdict, "conflict");
  assert.equal(report.conflicts.length, 1);
  assert.deepEqual(
    report.conflicts[0].records.map((r) => r.exitCode).sort(),
    [0, 1],
  );
});

test("report output exposes missing, conflict, failure and stale evidence", () => {
  const log = new AuditLog();
  log.add(rec({ suite: "unit", sourceHash: H1, exitCode: 0 }));
  log.add(rec({ suite: "unit", sourceHash: H1, exitCode: 2 }));
  log.add(rec({ suite: "old-suite", sourceHash: H2, exitCode: 0 }));
  const text = formatReport(evaluateArtifact(log, H1, REQUIRED));
  assert.match(text, /verdict=conflict/);
  assert.match(text, /CONFLICT suite=unit/);
  assert.match(text, /MISSING  suite=lint/);
  assert.match(text, /STALE    suite=old-suite/);
});

function spawnAllowed(): boolean {
  try {
    const res = spawnSync("true", { shell: true });
    return !res.error;
  } catch {
    return false;
  }
}

test("runAndRecord binds the actual process exit code to the on-disk hash", (t) => {
  if (!spawnAllowed()) {
    t.skip("sandbox denies spawning subprocesses");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "audit-run-"));
  writeFileSync(join(dir, "main.ts"), "export {};\n");
  const log = new AuditLog();

  const ok = runAndRecord(log, dir, "unit", "node -e \"process.exit(0)\"");
  assert.equal(ok.exitCode, 0);
  const bad = runAndRecord(log, dir, "e2e", "node -e \"process.exit(7)\"");
  assert.equal(bad.exitCode, 7);
  assert.equal(ok.sourceHash, bad.sourceHash);

  const report = evaluateArtifact(log, ok.sourceHash, [
    { suite: "unit", command: "node -e \"process.exit(0)\"" },
    { suite: "e2e", command: "node -e \"process.exit(7)\"" },
  ]);
  assert.equal(report.verdict, "fail");
  assert.equal(report.failures[0].exitCode, 7);
});
