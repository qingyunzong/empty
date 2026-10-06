import test from "node:test";
import assert from "node:assert/strict";
import { parseConstraint } from "../src/parser.js";
import {
  INT64_MAX,
  INT64_MIN,
  UnsupportedConstraintError,
  solveSystem,
  type Domain,
} from "../src/solver.js";

function solve(
  vars: Record<string, [bigint, bigint]>,
  constraints: string[],
) {
  const map = new Map<string, Domain>(
    Object.entries(vars).map(([k, [lo, hi]]) => [k, { lo, hi }]),
  );
  return solveSystem(map, constraints.map(parseConstraint));
}

const FULL: [bigint, bigint] = [INT64_MIN, INT64_MAX];

test("simple inequality over full int64 domain", () => {
  const r = solve({ x: FULL }, ["2*x + 3 <= 10"]);
  assert.equal(r.status, "sat");
  if (r.status !== "sat") return;
  const s = r.solutions.get("x")!;
  assert.equal(s.end, 3n);
  assert.equal(s.start, INT64_MIN);
  assert.equal(s.step, 1n);
});

test("strict upper bound at INT64_MAX is exact (no float rounding)", () => {
  // A float-based conversion would round 2^63-1 to 2^63 and misplace the bound.
  const r = solve({ x: FULL }, ["x < 9223372036854775807"]);
  assert.equal(r.status, "sat");
  if (r.status !== "sat") return;
  assert.equal(r.solutions.get("x")!.end, INT64_MAX - 1n);
});

test("strict lower bound at INT64_MIN is exact", () => {
  const r = solve({ x: FULL }, ["x > -9223372036854775808"]);
  assert.equal(r.status, "sat");
  if (r.status !== "sat") return;
  assert.equal(r.solutions.get("x")!.start, INT64_MIN + 1n);
});

test("huge coefficients use exact floor division", () => {
  const r = solve({ x: FULL }, ["3*x <= 9223372036854775806"]);
  assert.equal(r.status, "sat");
  if (r.status !== "sat") return;
  assert.equal(r.solutions.get("x")!.end, 3074457345618258602n);
});

test("count spans the whole int64 range without floats", () => {
  const r = solve({ x: FULL }, []);
  assert.equal(r.status, "sat");
  if (r.status !== "sat") return;
  assert.equal(r.solutions.get("x")!.count, 1n << 64n);
});

test("single congruence produces a step interval", () => {
  const r = solve({ x: [0n, 100n] }, ["x % 7 == 3"]);
  assert.equal(r.status, "sat");
  if (r.status !== "sat") return;
  assert.deepEqual(r.solutions.get("x"), { start: 3n, end: 94n, step: 7n, count: 14n });
});

test("linear congruence with non-coprime coefficient", () => {
  // 2*x ≡ 4 (mod 6)  <=>  x ≡ 2 (mod 3)
  const r = solve({ x: [0n, 10n] }, ["2*x % 6 == 4"]);
  assert.equal(r.status, "sat");
  if (r.status !== "sat") return;
  assert.deepEqual(r.solutions.get("x"), { start: 2n, end: 8n, step: 3n, count: 3n });
});

test("CRT merges non-coprime congruences", () => {
  // x ≡ 1 (mod 4), x ≡ 3 (mod 6)  =>  x ≡ 9 (mod 12)
  const r = solve({ x: [0n, 100n] }, ["x % 4 == 1", "x % 6 == 3"]);
  assert.equal(r.status, "sat");
  if (r.status !== "sat") return;
  assert.deepEqual(r.solutions.get("x"), { start: 9n, end: 93n, step: 12n, count: 8n });
});

test("CRT conflict yields a certificate", () => {
  const r = solve({ x: [0n, 100n] }, ["x % 4 == 1", "x % 6 == 2"]);
  assert.equal(r.status, "unsat");
  if (r.status !== "unsat") return;
  assert.equal(r.certificate.type, "crt-conflict");
  assert.equal(r.variable, "x");
});

test("unsolvable congruence yields a certificate", () => {
  const r = solve({ x: [0n, 100n] }, ["2*x % 6 == 3"]);
  assert.equal(r.status, "unsat");
  if (r.status !== "unsat") return;
  assert.equal(r.certificate.type, "congruence-unsolvable");
});

test("bound conflict yields a certificate naming both sources", () => {
  const r = solve({ x: [0n, 100n] }, ["x >= 10", "x <= 5"]);
  assert.equal(r.status, "unsat");
  if (r.status !== "unsat") return;
  assert.equal(r.certificate.type, "bound-conflict");
  if (r.certificate.type !== "bound-conflict") return;
  assert.equal(r.certificate.lower.value, 10n);
  assert.equal(r.certificate.upper.value, 5n);
});

test("equality pins the variable; non-integral equality is unsat", () => {
  const ok = solve({ x: [0n, 100n] }, ["3*x == 12"]);
  assert.equal(ok.status, "sat");
  if (ok.status === "sat") {
    assert.deepEqual(ok.solutions.get("x"), { start: 4n, end: 4n, step: 1n, count: 1n });
  }
  const bad = solve({ x: [0n, 100n] }, ["3*x == 10"]);
  assert.equal(bad.status, "unsat");
  if (bad.status === "unsat") assert.equal(bad.certificate.type, "equality-not-integral");
});

test("residue class outside the range yields no-solution-in-range", () => {
  const r = solve({ x: [0n, 2n] }, ["x % 7 == 5"]);
  assert.equal(r.status, "unsat");
  if (r.status !== "unsat") return;
  assert.equal(r.certificate.type, "no-solution-in-range");
});

test("constant false constraint yields constant-contradiction", () => {
  const r = solve({ x: [0n, 2n] }, ["5 <= 3"]);
  assert.equal(r.status, "unsat");
  if (r.status !== "unsat") return;
  assert.equal(r.certificate.type, "constant-contradiction");
  assert.equal(r.variable, null);
});

test("multiple independent variables are solved separately", () => {
  const r = solve({ x: [0n, 50n], y: [-10n, 10n] }, [
    "x % 7 == 3",
    "y >= -4",
    "y < 2",
  ]);
  assert.equal(r.status, "sat");
  if (r.status !== "sat") return;
  assert.deepEqual(r.solutions.get("x"), { start: 3n, end: 45n, step: 7n, count: 7n });
  assert.deepEqual(r.solutions.get("y"), { start: -4n, end: 1n, step: 1n, count: 6n });
});

test("mixed-variable constraints are rejected explicitly", () => {
  assert.throws(
    () => solve({ x: [0n, 5n], y: [0n, 5n] }, ["x + y <= 5"]),
    UnsupportedConstraintError,
  );
});

test("64-bit domain bounds are enforced", () => {
  assert.throws(
    () => solve({ x: [INT64_MIN, INT64_MAX + 1n] }, []),
    /64-bit/,
  );
});
