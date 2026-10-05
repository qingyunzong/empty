import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, checkResult, type LPInput, type SolveResult } from "../src/index.js";
import { R } from "../src/rational.js";

function solved(p: LPInput): SolveResult {
  const r = solve(p);
  const check = checkResult(p, r);
  assert.ok(check.ok, `certificate check failed: ${JSON.stringify(check)}`);
  return r;
}

test("optimal: bounded 2-var problem with exact vertex and duals", () => {
  const p: LPInput = {
    numVars: 2,
    objective: [3, 2],
    constraints: [
      { coeffs: [1, 2], sense: "<=", rhs: 4 },
      { coeffs: [2, 1], sense: "<=", rhs: 5 },
    ],
  };
  const r = solved(p);
  assert.equal(r.status, "optimal");
  if (r.status !== "optimal") return;
  assert.equal(r.objectiveValue.toString(), "8");
  assert.deepEqual(r.primal.map(String), ["2", "1"]);
  assert.deepEqual(r.dual.map(String), ["1/3", "4/3"]);
});

test("optimal: fractional data stays exact", () => {
  // max x+y s.t. 2x+y <= 7/2, x+2y <= 7/2  ->  x=y=7/6, obj 7/3
  const p: LPInput = {
    numVars: 2,
    objective: [1, 1],
    constraints: [
      { coeffs: [2, 1], sense: "<=", rhs: "7/2" },
      { coeffs: [1, 2], sense: "<=", rhs: "7/2" },
    ],
  };
  const r = solved(p);
  assert.equal(r.status, "optimal");
  if (r.status !== "optimal") return;
  assert.equal(r.objectiveValue.toString(), "7/3");
  assert.deepEqual(r.primal.map(String), ["7/6", "7/6"]);
});

test("infeasible: contradictory bounds, Farkas certificate", () => {
  const p: LPInput = {
    numVars: 2,
    objective: [1, 1],
    constraints: [
      { coeffs: [1, 1], sense: "<=", rhs: 1 },
      { coeffs: [1, 1], sense: ">=", rhs: 3 },
    ],
  };
  const r = solved(p);
  assert.equal(r.status, "infeasible");
});

test("infeasible: equality forces negative variable", () => {
  const p: LPInput = {
    numVars: 2,
    objective: [1, 0],
    constraints: [{ coeffs: [1, 1], sense: "=", rhs: -1 }],
  };
  const r = solved(p);
  assert.equal(r.status, "infeasible");
});

test("unbounded: feasible point plus exact recession ray", () => {
  const p: LPInput = {
    numVars: 2,
    objective: [1, 1],
    constraints: [{ coeffs: [1, -1], sense: "<=", rhs: 1 }],
  };
  const r = solved(p);
  assert.equal(r.status, "unbounded");
  if (r.status !== "unbounded") return;
  assert.ok(r.ray.every((v) => !v.isNegative()));
});

test("unbounded: free variable, no constraints", () => {
  const p: LPInput = { numVars: 1, objective: [1], nonnegative: [false] };
  const r = solved(p);
  assert.equal(r.status, "unbounded");
});

test("optimal: equality constraint", () => {
  const p: LPInput = {
    numVars: 2,
    objective: [1, 2],
    constraints: [
      { coeffs: [1, 1], sense: "=", rhs: 4 },
      { coeffs: [1, 0], sense: "<=", rhs: 3 },
    ],
  };
  const r = solved(p);
  assert.equal(r.status, "optimal");
  if (r.status !== "optimal") return;
  assert.equal(r.objectiveValue.toString(), "8");
  assert.deepEqual(r.primal.map(String), ["0", "4"]);
});

test("optimal: free variable bounded above", () => {
  const p: LPInput = {
    numVars: 1,
    objective: [1],
    nonnegative: [false],
    constraints: [{ coeffs: [1], sense: "<=", rhs: 5 }],
  };
  const r = solved(p);
  assert.equal(r.status, "optimal");
  if (r.status !== "optimal") return;
  assert.equal(r.objectiveValue.toString(), "5");
});

test("optimal: minimization is normalized and reported correctly", () => {
  const p: LPInput = {
    numVars: 2,
    objective: [1, 1],
    direction: "min",
    constraints: [{ coeffs: [1, 2], sense: ">=", rhs: 4 }],
  };
  const r = solved(p);
  assert.equal(r.status, "optimal");
  if (r.status !== "optimal") return;
  assert.equal(r.objectiveValue.toString(), "2");
  assert.deepEqual(r.primal.map(String), ["0", "2"]);
});

test("optimal: Beale cycling example terminates via Bland's rule", () => {
  // Classic degenerate LP that cycles under naive largest-coefficient pivoting.
  const p: LPInput = {
    numVars: 4,
    objective: ["3/4", -150, "1/50", -6],
    constraints: [
      { coeffs: ["1/4", -60, "-1/25", 9], sense: "<=", rhs: 0 },
      { coeffs: ["1/2", -90, "-1/50", 3], sense: "<=", rhs: 0 },
      { coeffs: [0, 0, 1, 0], sense: "<=", rhs: 1 },
    ],
  };
  const r = solved(p);
  assert.equal(r.status, "optimal");
  if (r.status !== "optimal") return;
  assert.equal(r.objectiveValue.toString(), "1/20");
});

test("optimal: highly degenerate problem (many ties)", () => {
  const p: LPInput = {
    numVars: 3,
    objective: [1, 1, 1],
    constraints: [
      { coeffs: [1, 0, 0], sense: "<=", rhs: 1 },
      { coeffs: [0, 1, 0], sense: "<=", rhs: 1 },
      { coeffs: [0, 0, 1], sense: "<=", rhs: 1 },
      { coeffs: [1, 1, 1], sense: "<=", rhs: 1 },
    ],
  };
  const r = solved(p);
  assert.equal(r.status, "optimal");
  if (r.status !== "optimal") return;
  assert.equal(r.objectiveValue.toString(), "1");
});

test("limits: rejects >6 variables or >12 constraints", () => {
  assert.throws(() =>
    solve({ numVars: 7, objective: [1, 1, 1, 1, 1, 1, 1] }),
  );
  assert.throws(() =>
    solve({
      numVars: 1,
      objective: [1],
      constraints: Array.from({ length: 13 }, () => ({
        coeffs: [1],
        sense: "<=" as const,
        rhs: 1,
      })),
    }),
  );
});

test("exactness: optimum with huge rationals no float could represent", () => {
  // max x s.t. x <= 1/10^30 exactly
  const p: LPInput = {
    numVars: 1,
    objective: [1],
    constraints: [{ coeffs: [1], sense: "<=", rhs: R(`1/${"1".padEnd(31, "0")}`) }],
  };
  const r = solved(p);
  assert.equal(r.status, "optimal");
  if (r.status !== "optimal") return;
  assert.equal(r.objectiveValue.toString(), `1/${"1".padEnd(31, "0")}`);
});
