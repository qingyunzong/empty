import { test } from "node:test";
import assert from "node:assert/strict";
import {
  solve,
  checkResult,
  normalize,
  toCanonical,
  solveByEnumeration,
  solveSquare,
  type LPInput,
} from "../src/index.js";
import { R } from "../src/rational.js";

function crossCheck(p: LPInput): void {
  const simplex = solve(p);
  const lp = normalize(p);
  const can = toCanonical(lp);
  const enumResult = solveByEnumeration(can);
  assert.notEqual(enumResult.status, "skipped", "enumeration should not skip small cases");
  assert.equal(
    enumResult.status,
    simplex.status,
    `status mismatch: simplex=${simplex.status} enumeration=${enumResult.status}`,
  );
  if (simplex.status === "optimal" && enumResult.status === "optimal") {
    const simplexVal = lp.flipped ? simplex.objectiveValue.neg() : simplex.objectiveValue;
    assert.ok(
      simplexVal.eq(enumResult.objectiveValue),
      `value mismatch: simplex=${simplexVal} enumeration=${enumResult.objectiveValue}`,
    );
  }
  // The simplex certificates must always verify independently.
  assert.deepEqual(checkResult(p, simplex), { ok: true });
}

test("solveSquare: exact 2x2 and singular detection", () => {
  const x = solveSquare(
    [
      [R(2), R(1)],
      [R(1), R(3)],
    ],
    [R(5), R(10)],
  );
  assert.deepEqual(x?.map(String), ["1", "3"]);
  assert.equal(
    solveSquare(
      [
        [R(1), R(1)],
        [R(2), R(2)],
      ],
      [R(1), R(2)],
    ),
    null,
  );
});

test("cross-check: bounded optimal", () => {
  crossCheck({
    numVars: 2,
    objective: [3, 2],
    constraints: [
      { coeffs: [1, 2], sense: "<=", rhs: 4 },
      { coeffs: [2, 1], sense: "<=", rhs: 5 },
    ],
  });
});

test("cross-check: infeasible", () => {
  crossCheck({
    numVars: 2,
    objective: [1, 1],
    constraints: [
      { coeffs: [1, 1], sense: "<=", rhs: 1 },
      { coeffs: [1, 1], sense: ">=", rhs: 3 },
    ],
  });
});

test("cross-check: unbounded", () => {
  crossCheck({
    numVars: 2,
    objective: [1, 1],
    constraints: [{ coeffs: [1, -1], sense: "<=", rhs: 1 }],
  });
});

test("cross-check: equality + free variable", () => {
  crossCheck({
    numVars: 2,
    objective: [1, -1],
    nonnegative: [true, false],
    constraints: [
      { coeffs: [1, 1], sense: "=", rhs: 3 },
      { coeffs: [1, -1], sense: "<=", rhs: 5 },
      { coeffs: [0, 1], sense: ">=", rhs: -4 },
    ],
  });
});

test("cross-check: Beale degenerate example", () => {
  crossCheck({
    numVars: 4,
    objective: ["3/4", -150, "1/50", -6],
    constraints: [
      { coeffs: ["1/4", -60, "-1/25", 9], sense: "<=", rhs: 0 },
      { coeffs: ["1/2", -90, "-1/50", 3], sense: "<=", rhs: 0 },
      { coeffs: [0, 0, 1, 0], sense: "<=", rhs: 1 },
    ],
  });
});

test("cross-check: min direction", () => {
  crossCheck({
    numVars: 3,
    objective: [2, 1, 3],
    direction: "min",
    constraints: [
      { coeffs: [1, 1, 1], sense: ">=", rhs: 4 },
      { coeffs: [1, -1, 0], sense: "<=", rhs: 2 },
      { coeffs: [0, 1, 2], sense: "=", rhs: 5 },
    ],
  });
});
