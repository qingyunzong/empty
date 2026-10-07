"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.describeCertificate = describeCertificate;
exports.formatInterval = formatInterval;
exports.formatVarSolution = formatVarSolution;
exports.formatVerification = formatVerification;
exports.formatHuman = formatHuman;
exports.formatJson = formatJson;
function describeCertificate(cert) {
    switch (cert.type) {
        case "constant-contradiction":
            return `constant contradiction in ${cert.constraint}: ${cert.detail}`;
        case "empty-interval":
            return `empty interval: lower bound ${cert.lower.value} (from ${cert.lower.source}) exceeds upper bound ${cert.upper.value} (from ${cert.upper.source})`;
        case "congruence-unsolvable":
            return `congruence ${cert.constraint} has no solution: ${cert.detail}`;
        case "crt-conflict":
            return `congruence ${cert.conflicting} conflicts with [${cert.accumulated.join(", ")}]: residues differ mod gcd ${cert.gcd}`;
        case "no-solution-in-interval":
            return `no x === ${cert.residue} (mod ${cert.modulus}) lies in [${cert.lo}, ${cert.hi}]`;
    }
}
function intervalValues(iv) {
    const out = [];
    for (let v = iv.start; v <= iv.end; v += iv.step)
        out.push(v);
    return out;
}
function formatInterval(iv) {
    if (iv.start === iv.end)
        return `{${iv.start}}`;
    if (iv.step === 1n)
        return `[${iv.start} .. ${iv.end}]`;
    return `[${iv.start} .. ${iv.end}] step ${iv.step}`;
}
const MAX_LISTED = 10;
function formatVarSolution(sol) {
    const lines = [];
    if (sol.status === "unsat") {
        lines.push(`${sol.variable}: UNSAT`);
        lines.push(`  certificate: ${describeCertificate(sol.certificate)}`);
        return lines.join("\n");
    }
    lines.push(`${sol.variable}: SAT, ${sol.solutionCount} solution${sol.solutionCount === 1n ? "" : "s"} in shrunk domain [${sol.bounds.lo}, ${sol.bounds.hi}]`);
    for (const iv of sol.intervals) {
        lines.push(`  ${formatInterval(iv)}`);
    }
    if (sol.solutionCount <= BigInt(MAX_LISTED)) {
        const values = sol.intervals.flatMap(intervalValues);
        lines.push(`  values: ${values.map(String).join(", ")}`);
    }
    return lines.join("\n");
}
function formatVerification(v) {
    const status = v.ok ? "OK" : "FAILED";
    let s = `  verification [${v.mode}]: ${status} — ${v.detail}`;
    for (const m of v.mismatches)
        s += `\n    mismatch: ${m}`;
    return s;
}
function formatHuman(result, verifications) {
    const parts = [];
    if (result.certificate) {
        parts.push(`UNSAT`);
        parts.push(`certificate: ${describeCertificate(result.certificate)}`);
        return parts.join("\n");
    }
    for (let i = 0; i < result.variables.length; i++) {
        parts.push(formatVarSolution(result.variables[i]));
        if (verifications)
            parts.push(formatVerification(verifications[i]));
    }
    parts.push(result.status === "sat" ? "status: SAT" : "status: UNSAT");
    return parts.join("\n");
}
function bigintReplacer(_key, value) {
    return typeof value === "bigint" ? value.toString() : value;
}
function formatJson(result, verifications) {
    return JSON.stringify({ ...result, verification: verifications }, bigintReplacer, 2);
}
