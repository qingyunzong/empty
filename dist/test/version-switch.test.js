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
/** Deterministic PRNG (mulberry32) so the random switching is reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const VERSIONS = [
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
for (const v of VERSIONS)
    v.hash = (0, index_1.hashSourceFiles)(v.files);
function checkout(dir, v) {
    (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    for (const [p, content] of Object.entries(v.files)) {
        (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)((0, node_path_1.join)(dir, p)), { recursive: true });
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, p), content);
    }
}
const REQUIRED = [{ suite: "unit", command: "npm test" }];
(0, node_test_1.test)("random version switching: judgments only ever use same-hash records", () => {
    const rand = mulberry32(20261007);
    const dir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "audit-switch-"));
    const log = new index_1.AuditLog();
    const visits = [];
    // 60 random checkouts; on each, verify the on-disk hash matches the
    // version's content hash, then record the suite outcome bound to it.
    for (let i = 0; i < 60; i++) {
        const v = VERSIONS[Math.floor(rand() * VERSIONS.length)];
        checkout(dir, v);
        const check = (0, index_1.verifySourceTree)(dir, v.hash);
        strict_1.default.ok(check.ok, `on-disk tree must match ${v.name} after checkout`);
        visits.push(v);
        const record = {
            suite: "unit",
            command: "npm test",
            exitCode: v.unitExit,
            sourceHash: (0, index_1.hashSourceTree)(dir),
            recordedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        };
        log.add(record);
    }
    strict_1.default.equal(log.all().length, 60);
    // Re-judge a random subsequence of visited versions and verify invariants.
    for (let i = 0; i < 30; i++) {
        const v = visits[Math.floor(rand() * visits.length)];
        const report = (0, index_1.evaluateArtifact)(log, v.hash, REQUIRED);
        // Every admissible record is bound to this exact hash.
        strict_1.default.ok(report.applicable.every((r) => r.sourceHash === v.hash));
        // Every other record is excluded as stale — never stitched in.
        strict_1.default.equal(report.applicable.length + report.excludedStale.length, 60);
        strict_1.default.ok(report.excludedStale.every((s) => s.record.sourceHash !== v.hash));
        // Verdict is fully determined by same-hash records only.
        strict_1.default.equal(report.verdict, v.unitExit === 0 ? "pass" : "fail");
        strict_1.default.equal(report.missing.length, 0);
    }
    // An unknown (never-tested) hash yields incomplete + everything stale.
    const ghost = (0, index_1.hashSourceFiles)({ "src/main.ts": "never seen\n" });
    const ghostReport = (0, index_1.evaluateArtifact)(log, ghost, REQUIRED);
    strict_1.default.equal(ghostReport.verdict, "incomplete");
    strict_1.default.equal(ghostReport.applicable.length, 0);
    strict_1.default.equal(ghostReport.excludedStale.length, 60);
    strict_1.default.equal(ghostReport.missing.length, 1);
    (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
});
(0, node_test_1.test)("file change verification: tampering invalidates prior records", () => {
    const dir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "audit-tamper-"));
    const v = VERSIONS[2]; // v3-fixed, previously passing
    checkout(dir, v);
    const snapshot = (0, index_1.readSourceTree)(dir);
    const log = new index_1.AuditLog();
    log.add({
        suite: "unit",
        command: "npm test",
        exitCode: 0,
        sourceHash: (0, index_1.hashSourceTree)(dir),
        recordedAt: new Date().toISOString(),
    });
    strict_1.default.equal((0, index_1.evaluateArtifact)(log, v.hash, REQUIRED).verdict, "pass");
    // Tamper: modify one file.
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, "src/main.ts"), "export const f = () => 999;\n");
    const tampered = (0, index_1.verifySourceTree)(dir, v.hash, snapshot);
    strict_1.default.equal(tampered.ok, false);
    strict_1.default.notEqual(tampered.actualHash, v.hash);
    strict_1.default.deepEqual(tampered.changedPaths, ["src/main.ts"]);
    // The old pass is now stale: judging the tampered tree finds no evidence.
    const report = (0, index_1.evaluateArtifact)(log, tampered.actualHash, REQUIRED);
    strict_1.default.equal(report.verdict, "incomplete");
    strict_1.default.equal(report.excludedStale.length, 1);
    strict_1.default.equal(report.missing.length, 1);
    // Delete a file: detected as a change as well.
    checkout(dir, v);
    (0, node_fs_1.unlinkSync)((0, node_path_1.join)(dir, "src/util.ts"));
    const deleted = (0, index_1.verifySourceTree)(dir, v.hash, snapshot);
    strict_1.default.equal(deleted.ok, false);
    strict_1.default.deepEqual(deleted.changedPaths, ["src/util.ts"]);
    // Restore: hash matches again and the original record is admissible.
    checkout(dir, v);
    const restored = (0, index_1.verifySourceTree)(dir, v.hash, snapshot);
    strict_1.default.ok(restored.ok);
    strict_1.default.equal(restored.changedPaths.length, 0);
    strict_1.default.equal((0, index_1.evaluateArtifact)(log, restored.actualHash, REQUIRED).verdict, "pass");
    (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
});
(0, node_test_1.test)("hash binds both paths and contents", () => {
    const a = (0, index_1.hashSourceFiles)({ "x.ts": "1", "y.ts": "2" });
    strict_1.default.equal(a, (0, index_1.hashSourceFiles)({ "y.ts": "2", "x.ts": "1" }), "order-independent");
    strict_1.default.notEqual(a, (0, index_1.hashSourceFiles)({ "x.ts": "1", "y.ts": "3" }), "content-sensitive");
    strict_1.default.notEqual(a, (0, index_1.hashSourceFiles)({ "x.ts": "1", "z.ts": "2" }), "path-sensitive");
    strict_1.default.notEqual(a, (0, index_1.hashSourceFiles)({ "x.ts": "1" }), "file-set-sensitive");
});
