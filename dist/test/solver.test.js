"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const node_assert_1 = __importDefault(require("node:assert"));
const parser_1 = require("../src/parser");
const solver_1 = require("../src/solver");
function solve(text) {
    const result = (0, solver_1.solveProblem)((0, parser_1.parseProblem)(text));
    node_assert_1.default.equal(result.variables.length, 1);
    return result.variables[0];
}
(0, node_test_1.default)("simple inequality clips the domain", () => {
    const sol = solve("var x in [0, 10]\nx <= 4");
    node_assert_1.default.equal(sol.status, "sat");
    node_assert_1.default.deepStrictEqual(sol.intervals, [{ start: 0n, end: 4n, step: 1n }]);
    node_assert_1.default.equal(sol.solutionCount, 5n);
});
(0, node_test_1.default)("strict inequality uses exact integer shift, not floats", () => {
    const sol = solve("var x in [0, 100]\n3*x < 10");
    node_assert_1.default.deepStrictEqual(sol.intervals, [{ start: 0n, end: 3n, step: 1n }]);
    const sol2 = solve("var x in [-100, 100]\n3*x > -10");
    node_assert_1.default.deepStrictEqual(sol2.intervals, [{ start: -3n, end: 100n, step: 1n }]);
});
(0, node_test_1.default)("strict greater-than with negative coefficient (regression)", () => {
    // -2x - 5 > 0  <=>  x <= -3
    const sol = solve("var x in [-22, 45]\n-2*x + (-5) > 0");
    node_assert_1.default.deepStrictEqual(sol.intervals, [{ start: -22n, end: -3n, step: 1n }]);
    const sol2 = solve("var x in [-100, 100]\nx > 3");
    node_assert_1.default.deepStrictEqual(sol2.intervals, [{ start: 4n, end: 100n, step: 1n }]);
});
(0, node_test_1.default)("huge coefficients stay exact where doubles would round", () => {
    // (9223372036854775799 - 3) / 8 = 1152921504606846974.5 -> floor 1152921504606846974.
    // A double would round the constant to 2^63 and produce 1152921504606846976.
    const sol = solve(`var x in [0, ${2n ** 62n}]\n8*x + 3 <= 9223372036854775799`);
    node_assert_1.default.equal(sol.bounds.hi, 1152921504606846974n);
    node_assert_1.default.deepStrictEqual(sol.intervals, [{ start: 0n, end: 1152921504606846974n, step: 1n }]);
});
(0, node_test_1.default)("congruence produces a stepped interval", () => {
    const sol = solve("var x in [0, 100]\nx % 7 == 3");
    node_assert_1.default.deepStrictEqual(sol.intervals, [{ start: 3n, end: 94n, step: 7n }]);
    node_assert_1.default.equal(sol.solutionCount, 14n);
});
(0, node_test_1.default)("linear congruence with gcd reduction", () => {
    const sol = solve("var x in [0, 20]\n3*x % 12 == 6");
    node_assert_1.default.deepStrictEqual(sol.intervals, [{ start: 2n, end: 18n, step: 4n }]);
});
(0, node_test_1.default)("CRT merges two congruences", () => {
    const sol = solve("var x in [0, 50]\nx % 4 == 1\nx % 6 == 3");
    node_assert_1.default.deepStrictEqual(sol.intervals, [{ start: 9n, end: 45n, step: 12n }]);
    node_assert_1.default.equal(sol.solutionCount, 4n);
});
(0, node_test_1.default)("CRT conflict yields a certificate", () => {
    const sol = solve("var x in [0, 50]\nx % 4 == 0\nx % 6 == 3");
    node_assert_1.default.equal(sol.status, "unsat");
    node_assert_1.default.equal(sol.certificate.type, "crt-conflict");
});
(0, node_test_1.default)("unsolvable congruence yields a certificate", () => {
    const sol = solve("var x in [0, 50]\n2*x % 6 == 3");
    node_assert_1.default.equal(sol.status, "unsat");
    node_assert_1.default.equal(sol.certificate.type, "congruence-unsolvable");
});
(0, node_test_1.default)("disequality splits intervals minimally", () => {
    const sol = solve("var x in [0, 10]\nx != 5");
    node_assert_1.default.deepStrictEqual(sol.intervals, [
        { start: 0n, end: 4n, step: 1n },
        { start: 6n, end: 10n, step: 1n },
    ]);
    node_assert_1.default.equal(sol.solutionCount, 10n);
});
(0, node_test_1.default)("disequality on a progression splits with the same step", () => {
    const sol = solve("var x in [0, 10]\nx % 2 == 0\nx != 4");
    node_assert_1.default.deepStrictEqual(sol.intervals, [
        { start: 0n, end: 2n, step: 2n },
        { start: 6n, end: 10n, step: 2n },
    ]);
});
(0, node_test_1.default)("disequality that never bites is ignored", () => {
    const sol = solve("var x in [0, 10]\n2*x != 3");
    node_assert_1.default.deepStrictEqual(sol.intervals, [{ start: 0n, end: 10n, step: 1n }]);
});
(0, node_test_1.default)("conflicting bounds yield an empty-interval certificate", () => {
    const sol = solve("var x in [0, 10]\nx >= 5\nx <= 3");
    node_assert_1.default.equal(sol.status, "unsat");
    const cert = sol.certificate;
    node_assert_1.default.equal(cert.type, "empty-interval");
    if (cert.type === "empty-interval") {
        node_assert_1.default.equal(cert.lower.value, 5n);
        node_assert_1.default.equal(cert.upper.value, 3n);
    }
});
(0, node_test_1.default)("progression missing the interval yields a certificate", () => {
    const sol = solve("var x in [3, 7]\nx % 10 == 0");
    node_assert_1.default.equal(sol.status, "unsat");
    node_assert_1.default.equal(sol.certificate.type, "no-solution-in-interval");
});
(0, node_test_1.default)("false constant constraint yields a certificate", () => {
    const result = (0, solver_1.solveProblem)((0, parser_1.parseProblem)("var x in [0, 10]\n3 < 0"));
    node_assert_1.default.equal(result.status, "unsat");
    node_assert_1.default.equal(result.certificate.type, "constant-contradiction");
});
(0, node_test_1.default)("full int64 domain with parity congruence", () => {
    const sol = solve(`var x in [${parser_1.INT64_MIN}, ${parser_1.INT64_MAX}]\nx % 2 == 1`);
    node_assert_1.default.deepStrictEqual(sol.intervals, [{ start: parser_1.INT64_MIN + 1n, end: parser_1.INT64_MAX, step: 2n }]);
    node_assert_1.default.equal(sol.solutionCount, 2n ** 63n);
});
(0, node_test_1.default)("equality constraint pins a single value", () => {
    const sol = solve("var x in [-100, 100]\n2*x + 4 == 10");
    node_assert_1.default.deepStrictEqual(sol.intervals, [{ start: 3n, end: 3n, step: 1n }]);
    node_assert_1.default.equal(sol.solutionCount, 1n);
});
(0, node_test_1.default)("large modulus congruence solved by modular inverse", () => {
    const sol = solve("var x in [0, 2000000000]\n1000000007*x % 1000000009 == 5");
    node_assert_1.default.equal(sol.status, "sat");
    node_assert_1.default.equal(sol.solutionCount, 2n);
    node_assert_1.default.deepStrictEqual(sol.intervals, [
        { start: 500000002n, end: 1500000011n, step: 1000000009n },
    ]);
    // cross-check each announced solution against the raw constraint
    for (const iv of sol.intervals) {
        for (let x = iv.start; x <= iv.end; x += iv.step) {
            node_assert_1.default.equal((1000000007n * x) % 1000000009n, 5n);
        }
    }
});
(0, node_test_1.default)("independent variables are solved separately", () => {
    const result = (0, solver_1.solveProblem)((0, parser_1.parseProblem)("var x in [0, 10]\nvar y in [0, 10]\nx <= 2\ny % 3 == 1"));
    node_assert_1.default.equal(result.status, "sat");
    node_assert_1.default.deepStrictEqual(result.variables[0].intervals, [{ start: 0n, end: 2n, step: 1n }]);
    node_assert_1.default.deepStrictEqual(result.variables[1].intervals, [{ start: 1n, end: 10n, step: 3n }]);
});
(0, node_test_1.default)("cross-variable constraints are rejected", () => {
    node_assert_1.default.throws(() => (0, solver_1.solveProblem)((0, parser_1.parseProblem)("var x in [0, 9]\nvar y in [0, 9]\nx + y <= 3")), solver_1.SolveError);
});
