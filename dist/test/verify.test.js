"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const node_assert_1 = __importDefault(require("node:assert"));
const parser_1 = require("../src/parser");
const solver_1 = require("../src/solver");
const verify_1 = require("../src/verify");
/** Deterministic RNG (test data generation only, never used by the solver). */
function makeRng(seed) {
    let s = seed >>> 0;
    return (n) => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s % n;
    };
}
function linStr(a, k) {
    return `${a}*x + (${k})`;
}
function expand(intervals) {
    const out = [];
    for (const iv of intervals)
        for (let v = iv.start; v <= iv.end; v += iv.step)
            out.push(v);
    return out;
}
(0, node_test_1.default)("randomized systems match brute-force enumeration exactly", () => {
    const rng = makeRng(20261008);
    const ops = ["<=", "<", ">=", ">", "==", "!="];
    for (let iter = 0; iter < 400; iter++) {
        const lo = -rng(60);
        const hi = rng(60);
        const lines = [`var x in [${lo}, ${hi}]`];
        const nIneq = rng(5);
        for (let i = 0; i < nIneq; i++) {
            const a = rng(13) - 6;
            const k = rng(61) - 30;
            lines.push(`${linStr(a, k)} ${ops[rng(ops.length)]} 0`);
        }
        const nCong = rng(3);
        for (let i = 0; i < nCong; i++) {
            const a = rng(9);
            const k = rng(25) - 12;
            const m = 1 + rng(12);
            lines.push(`${linStr(a, k)} % ${m} == 0`);
        }
        const nNeq = rng(3);
        for (let i = 0; i < nNeq; i++) {
            lines.push(`x != ${lo - 5 + rng(hi - lo + 11)}`);
        }
        const text = lines.join("\n");
        const problem = (0, parser_1.parseProblem)(text);
        const result = (0, solver_1.solveProblem)(problem);
        // Independent brute force over the whole declared domain.
        const expected = [];
        for (let x = BigInt(lo); x <= BigInt(hi); x++) {
            if (problem.constraints.every((c) => (0, verify_1.constraintHolds)(c, "x", x)))
                expected.push(x);
        }
        if (result.certificate !== null) {
            // A constant constraint failed: no variable assignment can help.
            node_assert_1.default.equal(result.status, "unsat");
            node_assert_1.default.equal(expected.length, 0, `constant contradiction but brute force found solutions for:\n${text}`);
            continue;
        }
        const sol = result.variables[0];
        if (expected.length === 0) {
            node_assert_1.default.equal(sol.status, "unsat", `expected UNSAT for:\n${text}`);
            node_assert_1.default.ok(sol.certificate !== null, `UNSAT must carry a certificate for:\n${text}`);
        }
        else {
            node_assert_1.default.equal(sol.status, "sat", `expected SAT for:\n${text}`);
            node_assert_1.default.deepStrictEqual(expand(sol.intervals), expected, `interval mismatch for:\n${text}`);
            node_assert_1.default.equal(sol.solutionCount, BigInt(expected.length));
            // Minimality: intervals share one step and are separated by >= 2 steps.
            const step = sol.intervals[0].step;
            for (let i = 0; i < sol.intervals.length; i++) {
                node_assert_1.default.equal(sol.intervals[i].step, step, `inconsistent step for:\n${text}`);
                if (i > 0) {
                    const gap = sol.intervals[i].start - sol.intervals[i - 1].end;
                    node_assert_1.default.ok(gap >= 2n * step, `intervals are mergeable (not minimal) for:\n${text}`);
                }
            }
        }
        // The verifier itself must confirm the result exhaustively.
        const reports = (0, verify_1.verifyProblem)(problem, result, 1000000n);
        node_assert_1.default.equal(reports.length, 1);
        node_assert_1.default.equal(reports[0].mode, "exhaustive");
        node_assert_1.default.ok(reports[0].ok, `verification failed for:\n${text}\n${reports[0].mismatches.join("\n")}`);
    }
});
(0, node_test_1.default)("boundary verification kicks in for huge shrunk domains", () => {
    const problem = (0, parser_1.parseProblem)(`var x in [${-(2n ** 63n)}, ${2n ** 63n - 1n}]\nx % 1000000007 == 42\nx != 42`);
    const result = (0, solver_1.solveProblem)(problem);
    node_assert_1.default.equal(result.status, "sat");
    const reports = (0, verify_1.verifyProblem)(problem, result, 1000n);
    node_assert_1.default.equal(reports[0].mode, "boundary");
    node_assert_1.default.ok(reports[0].ok);
    node_assert_1.default.ok(reports[0].candidatesChecked > 0n);
});
(0, node_test_1.default)("unsat certificates are confirmed by exhaustive scan", () => {
    const problem = (0, parser_1.parseProblem)("var x in [-40, 40]\n3*x % 9 == 1\nx >= -40");
    const result = (0, solver_1.solveProblem)(problem);
    node_assert_1.default.equal(result.status, "unsat");
    const reports = (0, verify_1.verifyProblem)(problem, result, 1000000n);
    node_assert_1.default.equal(reports[0].mode, "exhaustive");
    node_assert_1.default.ok(reports[0].ok);
    node_assert_1.default.equal(reports[0].candidatesChecked, 81n);
});
