"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const index_1 = require("../src/index");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_child_process_1 = require("node:child_process");
const H1 = (0, index_1.hashSourceFiles)({ "a.ts": "export const x = 1;" });
const H2 = (0, index_1.hashSourceFiles)({ "a.ts": "export const x = 2;" });
function rec(partial) {
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
(0, node_test_1.test)("record binds source hash, command and actual exit code; invalid records rejected", () => {
    const log = new index_1.AuditLog();
    const r = rec({ suite: "unit", sourceHash: H1, exitCode: 3, command: "make check" });
    log.add(r);
    strict_1.default.equal(log.all().length, 1);
    strict_1.default.throws(() => log.add(rec({ suite: "x", sourceHash: "deadbeef" })), /sha256/);
    strict_1.default.throws(() => log.add(rec({ suite: "x", sourceHash: H1, exitCode: 0.5 })), /integer/);
    strict_1.default.throws(() => log.add(rec({ suite: "", sourceHash: H1 })), /suite/);
});
(0, node_test_1.test)("only same-hash records are admissible for the current artifact", () => {
    const log = new index_1.AuditLog();
    log.add(rec({ suite: "unit", sourceHash: H1 }));
    log.add(rec({ suite: "unit", sourceHash: H2, exitCode: 1 }));
    strict_1.default.equal(log.forArtifact(H1).length, 1);
    strict_1.default.equal(log.forArtifact(H2)[0].exitCode, 1);
    const report = (0, index_1.evaluateArtifact)(log, H2, [{ suite: "unit", command: "npm test" }]);
    strict_1.default.equal(report.verdict, "fail");
    strict_1.default.equal(report.applicable.length, 1);
    strict_1.default.equal(report.excludedStale.length, 1);
    strict_1.default.equal(report.excludedStale[0].record.sourceHash, H1);
});
(0, node_test_1.test)("old pass and new failure are never stitched together", () => {
    const log = new index_1.AuditLog();
    // unit passed on the OLD hash; lint only failed on the NEW hash.
    log.add(rec({ suite: "unit", sourceHash: H1, exitCode: 0 }));
    log.add(rec({ suite: "lint", command: "npm run lint", sourceHash: H2, exitCode: 1 }));
    // Judging the NEW artifact: fail from lint, and unit is MISSING (its old
    // pass must not be carried over).
    const now = (0, index_1.evaluateArtifact)(log, H2, REQUIRED);
    strict_1.default.equal(now.verdict, "fail");
    strict_1.default.deepEqual(now.missing.map((m) => m.suite), ["unit"]);
    strict_1.default.equal(now.failures[0].suite, "lint");
    // Judging the OLD artifact: unit passed but lint evidence is missing —
    // the new failure must not be stitched in either direction.
    const old = (0, index_1.evaluateArtifact)(log, H1, REQUIRED);
    strict_1.default.equal(old.verdict, "incomplete");
    strict_1.default.deepEqual(old.missing.map((m) => m.suite), ["lint"]);
    strict_1.default.equal(old.failures.length, 0);
});
(0, node_test_1.test)("missing evidence is reported per required suite+command", () => {
    const log = new index_1.AuditLog();
    log.add(rec({ suite: "unit", sourceHash: H1 }));
    const report = (0, index_1.evaluateArtifact)(log, H1, REQUIRED);
    strict_1.default.equal(report.verdict, "incomplete");
    strict_1.default.equal(report.missing.length, 1);
    strict_1.default.equal(report.missing[0].reason, "no-record-for-current-hash");
    strict_1.default.equal(report.missing[0].command, "npm run lint");
});
(0, node_test_1.test)("conflicting exit codes for the same hash+suite+command are reported", () => {
    const log = new index_1.AuditLog();
    log.add(rec({ suite: "unit", sourceHash: H1, exitCode: 0, recordedAt: "2026-10-07T00:00:00Z" }));
    log.add(rec({ suite: "unit", sourceHash: H1, exitCode: 1, recordedAt: "2026-10-07T01:00:00Z" }));
    log.add(rec({ suite: "lint", command: "npm run lint", sourceHash: H1 }));
    const report = (0, index_1.evaluateArtifact)(log, H1, REQUIRED);
    strict_1.default.equal(report.verdict, "conflict");
    strict_1.default.equal(report.conflicts.length, 1);
    strict_1.default.deepEqual(report.conflicts[0].records.map((r) => r.exitCode).sort(), [0, 1]);
});
(0, node_test_1.test)("report output exposes missing, conflict, failure and stale evidence", () => {
    const log = new index_1.AuditLog();
    log.add(rec({ suite: "unit", sourceHash: H1, exitCode: 0 }));
    log.add(rec({ suite: "unit", sourceHash: H1, exitCode: 2 }));
    log.add(rec({ suite: "old-suite", sourceHash: H2, exitCode: 0 }));
    const text = (0, index_1.formatReport)((0, index_1.evaluateArtifact)(log, H1, REQUIRED));
    strict_1.default.match(text, /verdict=conflict/);
    strict_1.default.match(text, /CONFLICT suite=unit/);
    strict_1.default.match(text, /MISSING  suite=lint/);
    strict_1.default.match(text, /STALE    suite=old-suite/);
});
function spawnAllowed() {
    try {
        const res = (0, node_child_process_1.spawnSync)("true", { shell: true });
        return !res.error;
    }
    catch {
        return false;
    }
}
(0, node_test_1.test)("runAndRecord binds the actual process exit code to the on-disk hash", (t) => {
    if (!spawnAllowed()) {
        t.skip("sandbox denies spawning subprocesses");
        return;
    }
    const dir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "audit-run-"));
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, "main.ts"), "export {};\n");
    const log = new index_1.AuditLog();
    const ok = (0, index_1.runAndRecord)(log, dir, "unit", "node -e \"process.exit(0)\"");
    strict_1.default.equal(ok.exitCode, 0);
    const bad = (0, index_1.runAndRecord)(log, dir, "e2e", "node -e \"process.exit(7)\"");
    strict_1.default.equal(bad.exitCode, 7);
    strict_1.default.equal(ok.sourceHash, bad.sourceHash);
    const report = (0, index_1.evaluateArtifact)(log, ok.sourceHash, [
        { suite: "unit", command: "node -e \"process.exit(0)\"" },
        { suite: "e2e", command: "node -e \"process.exit(7)\"" },
    ]);
    strict_1.default.equal(report.verdict, "fail");
    strict_1.default.equal(report.failures[0].exitCode, 7);
});
