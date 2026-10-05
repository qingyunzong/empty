import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, checkResult, type LPInput, type SolveResult } from "../src/index.js";
import { R } from "../src/rational.js";

const OPTIMAL: LPInput = {
  numVars: 2,
  objective: [3, 2],
  constraints: [
    { coeffs: [1, 2], sense: "<=", rhs: 4 },
    { coeffs: [2, 1], sense: "<=", rhs: 5 },
  ],
};
const INFEASIBLE: LPInput = {
  numVars: 2,
  objective: [1, 1],
  constraints: [
    { coeffs: [1, 1], sense: "<=", rhs: 1 },
    { coeffs: [1, 1], sense: ">=", rhs: 3 },
  ],
};
const UNBOUNDED: LPInput = {
  numVars: 2,
  objective: [1, 1],
  constraints: [{ coeffs: [1, -1], sense: "<=", rhs: 1 }],
};

function expectRejected(p: LPInput, r: SolveResult, why: string): void {
  const check = checkResult(p, r);
  assert.ok(!check.ok, `expected rejection (${why}) but got ok`);
}

test("valid certificates are accepted", () => {
  for (const p of [OPTIMAL, INFEASIBLE, UNBOUNDED]) {
    assert.deepEqual(checkResult(p, solve(p)), { ok: true });
  }
});

test("tampered objective value is rejected", () => {
  const r = solve(OPTIMAL);
  assert.equal(r.status, "optimal");
  if (r.status !== "optimal") return;
  expectRejected(OPTIMAL, { ...r, objectiveValue: r.objectiveValue.add(R(1)) }, "value+1");
  expectRejected(
    OPTIMAL,
    { ...r, objectiveValue: r.objectiveValue.sub(R("1/1000")) },
    "value-epsilon",
  );
});

test("infeasible primal point is rejected", () => {
  const r = solve(OPTIMAL);
  if (r.status !== "optimal") return;
  expectRejected(OPTIMAL, { ...r, primal: [R(100), R(100)] }, "infeasible x");
});

test("dual sign violation is rejected", () => {
  const r = solve(OPTIMAL);
  if (r.status !== "optimal") return;
  expectRejected(OPTIMAL, { ...r, dual: [R(-1), R(-1)] }, "negative duals");
});

test("dual infeasibility is rejected", () => {
  const r = solve(OPTIMAL);
  if (r.status !== "optimal") return;
  // y = 0 violates A^T y >= c since c > 0
  expectRejected(OPTIMAL, { ...r, dual: [R(0), R(0)] }, "A^T y >= c fails");
});

test("fake Farkas ray on a feasible problem is rejected", () => {
  expectRejected(INFEASIBLE, { status: "infeasible", farkas: [R(1), R(1)] }, "y2 > 0");
  expectRejected(INFEASIBLE, { status: "infeasible", farkas: [R(0), R(0)] }, "b.y = 0");
  expectRejected(INFEASIBLE, { status: "infeasible", farkas: [R(1), R(-2)] }, "A^T y < 0");
});

test("unbounded: ray with negative components is rejected", () => {
  expectRejected(
    UNBOUNDED,
    { status: "unbounded", point: [R(0), R(0)], ray: [R(-1), R(-1)] },
    "d < 0",
  );
});

test("unbounded: infeasible base point is rejected", () => {
  expectRejected(
    UNBOUNDED,
    { status: "unbounded", point: [R(0), R(-5)], ray: [R(1), R(1)] },
    "point infeasible",
  );
});

test("unbounded: ray increasing a <= constraint is rejected", () => {
  expectRejected(
    UNBOUNDED,
    { status: "unbounded", point: [R(0), R(0)], ray: [R(1), R(0)] },
    "a.d = 1 > 0",
  );
});

test("unbounded: ray with c.d = 0 is rejected", () => {
  expectRejected(
    UNBOUNDED,
    { status: "unbounded", point: [R(0), R(0)], ray: [R(0), R(0)] },
    "zero ray",
  );
});

test("checker is exact: no epsilon slack anywhere", () => {
  const r = solve(OPTIMAL);
  if (r.status !== "optimal") return;
  // Primal violated by 1/10^18 must still be rejected.
  const eps = R("1/1000000000000000000");
  expectRejected(
    OPTIMAL,
    { ...r, primal: [r.primal[0]!.add(eps), r.primal[1]!] },
    "1e-18 violation",
  );
});
