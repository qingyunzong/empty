"use strict";
/**
 * Audit core: test records are bound to (sourceHash, command, exitCode).
 * A record is only admissible evidence for the artifact whose source hash
 * matches the record's hash. Records from other hashes are never merged
 * into the current judgment ("no stitching" of old passes / new failures).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLog = void 0;
exports.evaluateArtifact = evaluateArtifact;
exports.formatReport = formatReport;
class AuditLog {
    records = [];
    add(record) {
        this.validate(record);
        this.records.push({ ...record });
    }
    validate(r) {
        if (!r.suite)
            throw new Error("record.suite is required");
        if (!r.command)
            throw new Error("record.command is required");
        if (!Number.isInteger(r.exitCode))
            throw new Error("record.exitCode must be an integer");
        if (!/^[0-9a-f]{64}$/.test(r.sourceHash)) {
            throw new Error("record.sourceHash must be a sha256 hex digest");
        }
    }
    all() {
        return this.records;
    }
    /** Records admissible for a given artifact hash (and optional command). */
    forArtifact(sourceHash, command) {
        return this.records.filter((r) => r.sourceHash === sourceHash && (command === undefined || r.command === command));
    }
}
exports.AuditLog = AuditLog;
const KEY_SEP = "\u001f";
/**
 * Judge the artifact identified by `currentHash` using ONLY records bound
 * to that hash. Everything else is reported as excluded stale evidence.
 *
 * Verdict precedence: conflict > fail > incomplete > pass.
 */
function evaluateArtifact(log, currentHash, required) {
    const applicable = [];
    const excludedStale = [];
    for (const r of log.all()) {
        if (r.sourceHash === currentHash)
            applicable.push(r);
        else
            excludedStale.push({ record: r, reason: "hash-mismatch-excluded" });
    }
    const conflicts = [];
    const byKey = new Map();
    for (const r of applicable) {
        const key = r.suite + KEY_SEP + r.command;
        const group = byKey.get(key) ?? [];
        group.push(r);
        byKey.set(key, group);
    }
    for (const [key, group] of byKey) {
        const codes = new Set(group.map((r) => r.exitCode));
        if (codes.size > 1) {
            const [suite, command] = key.split(KEY_SEP);
            conflicts.push({ suite, command, records: group });
        }
    }
    const missing = [];
    for (const req of required) {
        const hit = applicable.some((r) => r.suite === req.suite && r.command === req.command);
        if (!hit) {
            missing.push({ ...req, reason: "no-record-for-current-hash" });
        }
    }
    const failures = applicable.filter((r) => r.exitCode !== 0);
    let verdict;
    if (conflicts.length > 0)
        verdict = "conflict";
    else if (failures.length > 0)
        verdict = "fail";
    else if (missing.length > 0)
        verdict = "incomplete";
    else
        verdict = "pass";
    return { sourceHash: currentHash, verdict, applicable, missing, conflicts, failures, excludedStale };
}
/** Human-readable evidence summary (missing / conflict / stale / failures). */
function formatReport(report) {
    const lines = [];
    lines.push("artifact " + report.sourceHash.slice(0, 12) + "... verdict=" + report.verdict);
    for (const m of report.missing) {
        lines.push(`MISSING  suite=${m.suite} command=${m.command} (${m.reason})`);
    }
    for (const c of report.conflicts) {
        const codes = c.records.map((r) => r.exitCode).join(" vs ");
        lines.push(`CONFLICT suite=${c.suite} command=${c.command} exitCodes=[${codes}]`);
    }
    for (const f of report.failures) {
        lines.push(`FAILURE  suite=${f.suite} command=${f.command} exitCode=${f.exitCode}`);
    }
    for (const s of report.excludedStale) {
        lines.push(`STALE    suite=${s.record.suite} hash=${s.record.sourceHash.slice(0, 12)}... (${s.reason})`);
    }
    return lines.join("\n");
}
