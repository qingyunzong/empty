import { test, describe } from "node:test";
import {
  equal,
  deepEqual,
  ok,
  notEqual,
} from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditLog,
  hashContents,
  hashFiles,
  runAndRecord,
} from "../src/index";

const COMMANDS = ["npm run build", "npm run lint", "npm test"] as const;

function hashOf(version: string): string {
  return hashContents([["src/main.ts", `// version ${version}\n`]]);
}

describe("same-hash binding", () => {
  test("all-green records for the current hash yield pass", () => {
    const log = new AuditLog();
    const hash = hashOf("v1");
    for (const command of COMMANDS) {
      log.record({ sourceHash: hash, command, exitCode: 0 });
    }
    const verdict = log.evaluate(hash, COMMANDS);
    equal(verdict.status, "pass");
    deepEqual(verdict.passed, [...COMMANDS]);
    equal(verdict.missing.length, 0);
    equal(verdict.conflicts.length, 0);
    equal(verdict.failures.length, 0);
  });

  test("verdict exposes the hash it judged", () => {
    const log = new AuditLog();
    const hash = hashOf("v1");
    log.record({ sourceHash: hash, command: "npm test", exitCode: 0 });
    equal(log.evaluate(hash, ["npm test"]).sourceHash, hash);
  });
});

describe("no splicing of stale passes with new failures", () => {
  test("old pass never rescues a failing new hash", () => {
    const log = new AuditLog();
    const oldHash = hashOf("v1");
    const newHash = hashOf("v2");
    // Old version: everything green.
    for (const command of COMMANDS) {
      log.record({ sourceHash: oldHash, command, exitCode: 0 });
    }
    // New version: tests actually fail.
    log.record({ sourceHash: newHash, command: "npm run build", exitCode: 0 });
    log.record({ sourceHash: newHash, command: "npm run lint", exitCode: 0 });
    log.record({ sourceHash: newHash, command: "npm test", exitCode: 1 });

    const verdict = log.evaluate(newHash, COMMANDS);
    equal(verdict.status, "fail");
    equal(verdict.failures.length, 1);
    equal(verdict.failures[0].command, "npm test");
    equal(verdict.failures[0].exitCode, 1);
    // The three stale passes were seen but excluded from the verdict.
    equal(verdict.staleRecordsIgnored.length, 3);
    ok(
      verdict.staleRecordsIgnored.every((r) => r.sourceHash === oldHash),
      "stale records must all belong to the old hash"
    );
  });

  test("stale pass does not fill a gap for the current hash", () => {
    const log = new AuditLog();
    const oldHash = hashOf("v1");
    const newHash = hashOf("v2");
    log.record({ sourceHash: oldHash, command: "npm test", exitCode: 0 });
    const verdict = log.evaluate(newHash, ["npm test"]);
    equal(verdict.status, "incomplete");
    equal(verdict.missing.length, 1);
    equal(verdict.missing[0].command, "npm test");
    equal(verdict.missing[0].reason, "no-record-for-current-hash");
  });
});

describe("missing and conflicting evidence", () => {
  test("missing evidence lists every unproven command", () => {
    const log = new AuditLog();
    const hash = hashOf("v1");
    log.record({ sourceHash: hash, command: "npm run build", exitCode: 0 });
    const verdict = log.evaluate(hash, COMMANDS);
    equal(verdict.status, "incomplete");
    deepEqual(
      verdict.missing.map((m) => m.command),
      ["npm run lint", "npm test"]
    );
  });

  test("conflicting exit codes for the same hash and command fail closed", () => {
    const log = new AuditLog();
    const hash = hashOf("v1");
    log.record({ sourceHash: hash, command: "npm test", exitCode: 0 });
    log.record({ sourceHash: hash, command: "npm test", exitCode: 2 });
    const verdict = log.evaluate(hash, ["npm test"]);
    equal(verdict.status, "fail");
    equal(verdict.conflicts.length, 1);
    const conflict = verdict.conflicts[0];
    equal(conflict.command, "npm test");
    equal(conflict.passRecords.length, 1);
    equal(conflict.passRecords[0].exitCode, 0);
    equal(conflict.failRecords.length, 1);
    equal(conflict.failRecords[0].exitCode, 2);
  });

  test("consistent non-zero exit codes report failure evidence", () => {
    const log = new AuditLog();
    const hash = hashOf("v1");
    log.record({ sourceHash: hash, command: "npm test", exitCode: 3 });
    log.record({ sourceHash: hash, command: "npm test", exitCode: 3 });
    const verdict = log.evaluate(hash, ["npm test"]);
    equal(verdict.status, "fail");
    equal(verdict.conflicts.length, 0);
    equal(verdict.failures[0].exitCode, 3);
    equal(verdict.failures[0].records.length, 2);
  });
});

describe("random version switching", () => {
  // Deterministic PRNG so the "random" switching is reproducible.
  function mulberry32(seed: number): () => number {
    let state = seed;
    return () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("interleaved runs across versions never contaminate verdicts", () => {
    const rand = mulberry32(20261007);
    const log = new AuditLog();

    const green = hashOf("green"); // all commands pass
    const broken = hashOf("broken"); // npm test fails
    const partial = hashOf("partial"); // lint never runs
    const flaky = hashOf("flaky"); // conflicting npm test outcomes
    const versions = [green, broken, partial, flaky];

    // Randomly switch versions and record each version's own truth.
    for (let step = 0; step < 200; step++) {
      const version = versions[Math.floor(rand() * versions.length)];
      const command = COMMANDS[Math.floor(rand() * COMMANDS.length)];
      if (version === partial && command === "npm run lint") continue;
      let exitCode = 0;
      if (version === broken && command === "npm test") exitCode = 1;
      if (version === flaky && command === "npm test") {
        exitCode = rand() < 0.5 ? 0 : 1;
      }
      log.record({ sourceHash: version, command, exitCode });
    }

    const greenVerdict = log.evaluate(green, COMMANDS);
    equal(greenVerdict.status, "pass");
    equal(greenVerdict.staleRecordsIgnored.length > 0, true);

    const brokenVerdict = log.evaluate(broken, COMMANDS);
    equal(brokenVerdict.status, "fail");
    ok(
      brokenVerdict.failures.some((f) => f.command === "npm test") ||
        brokenVerdict.conflicts.length > 0,
      "broken version must fail on npm test"
    );

    const partialVerdict = log.evaluate(partial, COMMANDS);
    equal(partialVerdict.status, "incomplete");
    deepEqual(
      partialVerdict.missing.map((m) => m.command),
      ["npm run lint"]
    );

    const flakyVerdict = log.evaluate(flaky, COMMANDS);
    equal(flakyVerdict.status, "fail");
    ok(
      flakyVerdict.conflicts.some((c) => c.command === "npm test"),
      "flaky version must surface the npm test conflict"
    );

    // No record ever leaked across hashes.
    for (const version of versions) {
      const verdict = log.evaluate(version, COMMANDS);
      ok(
        verdict.staleRecordsIgnored.every((r) => r.sourceHash !== version),
        "ignored records must never belong to the judged hash"
      );
    }
  });
});

describe("file change verification", () => {
  test("modifying a source file invalidates prior records", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    try {
      const main = join(dir, "main.ts");
      const util = join(dir, "util.ts");
      writeFileSync(main, "export const answer = 41;\n");
      writeFileSync(util, "export const inc = (x: number) => x + 1;\n");

      const log = new AuditLog();
      const before = hashFiles([main, util]);
      for (const command of COMMANDS) {
        log.record({ sourceHash: before, command, exitCode: 0 });
      }
      equal(log.evaluate(before, COMMANDS).status, "pass");

      // File changes: the artifact is no longer the one that was tested.
      writeFileSync(main, "export const answer = 42;\n");
      const after = hashFiles([main, util]);
      notEqual(after, before);

      const verdict = log.evaluate(after, COMMANDS);
      equal(verdict.status, "incomplete");
      equal(verdict.missing.length, COMMANDS.length);
      equal(verdict.staleRecordsIgnored.length, COMMANDS.length);

      // Re-running against the new content re-establishes proof.
      for (const command of COMMANDS) {
        log.record({ sourceHash: after, command, exitCode: 0 });
      }
      equal(log.evaluate(after, COMMANDS).status, "pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hash ignores enumeration order but not content", () => {
    const a = hashContents([
      ["b.ts", "2"],
      ["a.ts", "1"],
    ]);
    const b = hashContents([
      ["a.ts", "1"],
      ["b.ts", "2"],
    ]);
    const c = hashContents([
      ["a.ts", "1"],
      ["b.ts", "3"],
    ]);
    equal(a, b);
    notEqual(a, c);
  });
});

describe("actual exit codes", () => {
  test("runAndRecord captures the real process exit code", () => {
    const log = new AuditLog();
    const hash = hashOf("live");
    const passCmd = 'node -e "process.exit(0)"';
    const failCmd = 'node -e "process.exit(3)"';

    const passRec = runAndRecord(log, hash, passCmd);
    const failRec = runAndRecord(log, hash, failCmd);
    equal(passRec.exitCode, 0);
    equal(failRec.exitCode, 3);
    ok(passRec.recordedAt.length > 0);

    const verdict = log.evaluate(hash, [passCmd, failCmd]);
    equal(verdict.status, "fail");
    deepEqual(verdict.passed, [passCmd]);
    equal(verdict.failures[0].command, failCmd);
    equal(verdict.failures[0].exitCode, 3);
  });
});
