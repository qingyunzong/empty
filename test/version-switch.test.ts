import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuditLog,
  evaluateArtifact,
  hashSourceFiles,
  hashSourceTree,
  readSourceTree,
  verifySourceTree,
  TestRecord,
} from "../src/index";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/** Deterministic PRNG (mulberry32) so the random switching is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Version {
  name: string;
  files: Record<string, string>;
  hash: string;
  /** Deterministic "test outcome" derived from content: BUG => exit 1. */
  unitExit: number;
}

const VERSIONS: Version[] = [
  {
    name: "v1-clean",
    files: { "src/main.ts": "export const f = () => 1;\n", "README.md": "# demo v1\n" },
    hash: "",
    unitExit: 0,
  },
  {
    name: "v2-buggy",
    files: { "src/main.ts": "export const f = () => 1; // BUG\n", "README.md": "# demo v2\n" },
    hash: "",
    unitExit: 1,
  },
  {
    name: "v3-fixed",
    files: {
      "src/main.ts": "export const f = () => 2;\n",
      "src/util.ts": "export const g = () => 3;\n",
      "README.md": "# demo v3\n",
    },
    hash: "",
    unitExit: 0,
  },
];
for (const v of VERSIONS) v.hash = hashSourceFiles(v.files);

function checkout(dir: string, v: Version): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [p, content] of Object.entries(v.files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
}

const REQUIRED = [{ suite: "unit", command: "npm test" }];

test("random version switching: judgments only ever use same-hash records", () => {
  const rand = mulberry32(20261007);
  const dir = mkdtempSync(join(tmpdir(), "audit-switch-"));
  const log = new AuditLog();
  const visits: Version[] = [];

  // 60 random checkouts; on each, verify the on-disk hash matches the
  // version's content hash, then record the suite outcome bound to it.
  for (let i = 0; i < 60; i++) {
    const v = VERSIONS[Math.floor(rand() * VERSIONS.length)];
    checkout(dir, v);
    const check = verifySourceTree(dir, v.hash);
    assert.ok(check.ok, `on-disk tree must match ${v.name} after checkout`);
    visits.push(v);
    const record: TestRecord = {
      suite: "unit",
      command: "npm test",
      exitCode: v.unitExit,
      sourceHash: hashSourceTree(dir),
      recordedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    };
    log.add(record);
  }
  assert.equal(log.all().length, 60);

  // Re-judge a random subsequence of visited versions and verify invariants.
  for (let i = 0; i < 30; i++) {
    const v = visits[Math.floor(rand() * visits.length)];
    const report = evaluateArtifact(log, v.hash, REQUIRED);
    // Every admissible record is bound to this exact hash.
    assert.ok(report.applicable.every((r) => r.sourceHash === v.hash));
    // Every other record is excluded as stale — never stitched in.
    assert.equal(report.applicable.length + report.excludedStale.length, 60);
    assert.ok(report.excludedStale.every((s) => s.record.sourceHash !== v.hash));
    // Verdict is fully determined by same-hash records only.
    assert.equal(report.verdict, v.unitExit === 0 ? "pass" : "fail");
    assert.equal(report.missing.length, 0);
  }

  // An unknown (never-tested) hash yields incomplete + everything stale.
  const ghost = hashSourceFiles({ "src/main.ts": "never seen\n" });
  const ghostReport = evaluateArtifact(log, ghost, REQUIRED);
  assert.equal(ghostReport.verdict, "incomplete");
  assert.equal(ghostReport.applicable.length, 0);
  assert.equal(ghostReport.excludedStale.length, 60);
  assert.equal(ghostReport.missing.length, 1);

  rmSync(dir, { recursive: true, force: true });
});

test("file change verification: tampering invalidates prior records", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-tamper-"));
  const v = VERSIONS[2]; // v3-fixed, previously passing
  checkout(dir, v);
  const snapshot = readSourceTree(dir);

  const log = new AuditLog();
  log.add({
    suite: "unit",
    command: "npm test",
    exitCode: 0,
    sourceHash: hashSourceTree(dir),
    recordedAt: new Date().toISOString(),
  });
  assert.equal(evaluateArtifact(log, v.hash, REQUIRED).verdict, "pass");

  // Tamper: modify one file.
  writeFileSync(join(dir, "src/main.ts"), "export const f = () => 999;\n");
  const tampered = verifySourceTree(dir, v.hash, snapshot);
  assert.equal(tampered.ok, false);
  assert.notEqual(tampered.actualHash, v.hash);
  assert.deepEqual(tampered.changedPaths, ["src/main.ts"]);

  // The old pass is now stale: judging the tampered tree finds no evidence.
  const report = evaluateArtifact(log, tampered.actualHash, REQUIRED);
  assert.equal(report.verdict, "incomplete");
  assert.equal(report.excludedStale.length, 1);
  assert.equal(report.missing.length, 1);

  // Delete a file: detected as a change as well.
  checkout(dir, v);
  unlinkSync(join(dir, "src/util.ts"));
  const deleted = verifySourceTree(dir, v.hash, snapshot);
  assert.equal(deleted.ok, false);
  assert.deepEqual(deleted.changedPaths, ["src/util.ts"]);

  // Restore: hash matches again and the original record is admissible.
  checkout(dir, v);
  const restored = verifySourceTree(dir, v.hash, snapshot);
  assert.ok(restored.ok);
  assert.equal(restored.changedPaths.length, 0);
  assert.equal(evaluateArtifact(log, restored.actualHash, REQUIRED).verdict, "pass");

  rmSync(dir, { recursive: true, force: true });
});

test("hash binds both paths and contents", () => {
  const a = hashSourceFiles({ "x.ts": "1", "y.ts": "2" });
  assert.equal(a, hashSourceFiles({ "y.ts": "2", "x.ts": "1" }), "order-independent");
  assert.notEqual(a, hashSourceFiles({ "x.ts": "1", "y.ts": "3" }), "content-sensitive");
  assert.notEqual(a, hashSourceFiles({ "x.ts": "1", "z.ts": "2" }), "path-sensitive");
  assert.notEqual(a, hashSourceFiles({ "x.ts": "1" }), "file-set-sensitive");
});
