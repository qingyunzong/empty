import test from "node:test";
import assert from "node:assert";
import { parseProblem, INT64_MIN, INT64_MAX } from "../src/parser";
import { solveProblem, SolveError, VarSolution } from "../src/solver";

function solve(text: string): VarSolution {
  const result = solveProblem(parseProblem(text));
  assert.equal(result.variables.length, 1);
  return result.variables[0]!;
}

test("simple inequality clips the domain", () => {
  const sol = solve("var x in [0, 10]\nx <= 4");
  assert.equal(sol.status, "sat");
  assert.deepStrictEqual(sol.intervals, [{ start: 0n, end: 4n, step: 1n }]);
  assert.equal(sol.solutionCount, 5n);
});

test("strict inequality uses exact integer shift, not floats", () => {
  const sol = solve("var x in [0, 100]\n3*x < 10");
  assert.deepStrictEqual(sol.intervals, [{ start: 0n, end: 3n, step: 1n }]);
  const sol2 = solve("var x in [-100, 100]\n3*x > -10");
  assert.deepStrictEqual(sol2.intervals, [{ start: -3n, end: 100n, step: 1n }]);
});

test("strict greater-than with negative coefficient (regression)", () => {
  // -2x - 5 > 0  <=>  x <= -3
  const sol = solve("var x in [-22, 45]\n-2*x + (-5) > 0");
  assert.deepStrictEqual(sol.intervals, [{ start: -22n, end: -3n, step: 1n }]);
  const sol2 = solve("var x in [-100, 100]\nx > 3");
  assert.deepStrictEqual(sol2.intervals, [{ start: 4n, end: 100n, step: 1n }]);
});

test("huge coefficients stay exact where doubles would round", () => {
  // (9223372036854775799 - 3) / 8 = 1152921504606846974.5 -> floor 1152921504606846974.
  // A double would round the constant to 2^63 and produce 1152921504606846976.
  const sol = solve(`var x in [0, ${2n ** 62n}]\n8*x + 3 <= 9223372036854775799`);
  assert.equal(sol.bounds.hi, 1152921504606846974n);
  assert.deepStrictEqual(sol.intervals, [{ start: 0n, end: 1152921504606846974n, step: 1n }]);
});

test("congruence produces a stepped interval", () => {
  const sol = solve("var x in [0, 100]\nx % 7 == 3");
  assert.deepStrictEqual(sol.intervals, [{ start: 3n, end: 94n, step: 7n }]);
  assert.equal(sol.solutionCount, 14n);
});

test("linear congruence with gcd reduction", () => {
  const sol = solve("var x in [0, 20]\n3*x % 12 == 6");
  assert.deepStrictEqual(sol.intervals, [{ start: 2n, end: 18n, step: 4n }]);
});

test("CRT merges two congruences", () => {
  const sol = solve("var x in [0, 50]\nx % 4 == 1\nx % 6 == 3");
  assert.deepStrictEqual(sol.intervals, [{ start: 9n, end: 45n, step: 12n }]);
  assert.equal(sol.solutionCount, 4n);
});

test("CRT conflict yields a certificate", () => {
  const sol = solve("var x in [0, 50]\nx % 4 == 0\nx % 6 == 3");
  assert.equal(sol.status, "unsat");
  assert.equal(sol.certificate!.type, "crt-conflict");
});

test("unsolvable congruence yields a certificate", () => {
  const sol = solve("var x in [0, 50]\n2*x % 6 == 3");
  assert.equal(sol.status, "unsat");
  assert.equal(sol.certificate!.type, "congruence-unsolvable");
});

test("disequality splits intervals minimally", () => {
  const sol = solve("var x in [0, 10]\nx != 5");
  assert.deepStrictEqual(sol.intervals, [
    { start: 0n, end: 4n, step: 1n },
    { start: 6n, end: 10n, step: 1n },
  ]);
  assert.equal(sol.solutionCount, 10n);
});

test("disequality on a progression splits with the same step", () => {
  const sol = solve("var x in [0, 10]\nx % 2 == 0\nx != 4");
  assert.deepStrictEqual(sol.intervals, [
    { start: 0n, end: 2n, step: 2n },
    { start: 6n, end: 10n, step: 2n },
  ]);
});

test("disequality that never bites is ignored", () => {
  const sol = solve("var x in [0, 10]\n2*x != 3");
  assert.deepStrictEqual(sol.intervals, [{ start: 0n, end: 10n, step: 1n }]);
});

test("conflicting bounds yield an empty-interval certificate", () => {
  const sol = solve("var x in [0, 10]\nx >= 5\nx <= 3");
  assert.equal(sol.status, "unsat");
  const cert = sol.certificate!;
  assert.equal(cert.type, "empty-interval");
  if (cert.type === "empty-interval") {
    assert.equal(cert.lower.value, 5n);
    assert.equal(cert.upper.value, 3n);
  }
});

test("progression missing the interval yields a certificate", () => {
  const sol = solve("var x in [3, 7]\nx % 10 == 0");
  assert.equal(sol.status, "unsat");
  assert.equal(sol.certificate!.type, "no-solution-in-interval");
});

test("false constant constraint yields a certificate", () => {
  const result = solveProblem(parseProblem("var x in [0, 10]\n3 < 0"));
  assert.equal(result.status, "unsat");
  assert.equal(result.certificate!.type, "constant-contradiction");
});

test("full int64 domain with parity congruence", () => {
  const sol = solve(`var x in [${INT64_MIN}, ${INT64_MAX}]\nx % 2 == 1`);
  assert.deepStrictEqual(sol.intervals, [{ start: INT64_MIN + 1n, end: INT64_MAX, step: 2n }]);
  assert.equal(sol.solutionCount, 2n ** 63n);
});

test("equality constraint pins a single value", () => {
  const sol = solve("var x in [-100, 100]\n2*x + 4 == 10");
  assert.deepStrictEqual(sol.intervals, [{ start: 3n, end: 3n, step: 1n }]);
  assert.equal(sol.solutionCount, 1n);
});

test("large modulus congruence solved by modular inverse", () => {
  const sol = solve("var x in [0, 2000000000]\n1000000007*x % 1000000009 == 5");
  assert.equal(sol.status, "sat");
  assert.equal(sol.solutionCount, 2n);
  assert.deepStrictEqual(sol.intervals, [
    { start: 500000002n, end: 1500000011n, step: 1000000009n },
  ]);
  // cross-check each announced solution against the raw constraint
  for (const iv of sol.intervals) {
    for (let x = iv.start; x <= iv.end; x += iv.step) {
      assert.equal((1000000007n * x) % 1000000009n, 5n);
    }
  }
});

test("independent variables are solved separately", () => {
  const result = solveProblem(
    parseProblem("var x in [0, 10]\nvar y in [0, 10]\nx <= 2\ny % 3 == 1")
  );
  assert.equal(result.status, "sat");
  assert.deepStrictEqual(result.variables[0]!.intervals, [{ start: 0n, end: 2n, step: 1n }]);
  assert.deepStrictEqual(result.variables[1]!.intervals, [{ start: 1n, end: 10n, step: 3n }]);
});

test("cross-variable constraints are rejected", () => {
  assert.throws(
    () => solveProblem(parseProblem("var x in [0, 9]\nvar y in [0, 9]\nx + y <= 3")),
    SolveError
  );
});
