/**
 * Solve results on the ORIGINAL problem, with exact certificates, and an
 * independent checker that verifies them from first principles (exact
 * rational arithmetic only; no tolerances, no epsilons).
 *
 * Duality reference (objective normalized to maximization):
 *   primal:  max c.x   s.t.  a_i.x (<=|>=|=) b_i,  x_j >= 0 unless free
 *   dual:    y_i >= 0 for "<=",  y_i <= 0 for ">=",  y_i free for "="
 *            sum_i y_i a_ij  >= c_j  for x_j >= 0,  = c_j for free x_j
 *   strong duality: c.x* = b.y*
 *
 * Farkas (infeasibility):  y with the dual sign pattern above,
 *   sum_i y_i a_ij >= 0 (resp. = 0 for free x_j),  and  b.y < 0.
 *
 * Unboundedness: feasible point x0 and ray d with d_j >= 0 for x_j >= 0,
 *   a_i.d <= 0 / >= 0 / = 0 per sense,  c.d > 0.
 */
import { Rational, dot } from "./rational.js";
import { normalize, type LPInput, type NormalizedLP } from "./lp.js";

export type SolveResult =
  | { status: "optimal"; objectiveValue: Rational; primal: Rational[]; dual: Rational[] }
  | { status: "infeasible"; farkas: Rational[] }
  | { status: "unbounded"; point: Rational[]; ray: Rational[] };

export type CheckOutcome = { ok: true } | { ok: false; violations: string[] };

function checkPrimalFeasibility(
  lp: NormalizedLP,
  x: readonly Rational[],
  violations: string[],
  label: string,
): void {
  if (x.length !== lp.numVars) {
    violations.push(`${label}: expected ${lp.numVars} variables, got ${x.length}`);
    return;
  }
  lp.constraints.forEach((con, i) => {
    const lhs = dot(con.coeffs, x);
    const cmp = lhs.cmp(con.rhs);
    if (con.sense === "<=" && cmp > 0)
      violations.push(`${label}: constraint ${i} (${lhs} <= ${con.rhs}) violated`);
    if (con.sense === ">=" && cmp < 0)
      violations.push(`${label}: constraint ${i} (${lhs} >= ${con.rhs}) violated`);
    if (con.sense === "=" && cmp !== 0)
      violations.push(`${label}: constraint ${i} (${lhs} = ${con.rhs}) violated`);
  });
  lp.nonnegative.forEach((nn, j) => {
    if (nn && x[j]!.isNegative())
      violations.push(`${label}: x[${j}] = ${x[j]} < 0 violates nonnegativity`);
  });
}

/** Dual sign restrictions + dual feasibility, shared by optimal & Farkas. */
function checkDualPattern(
  lp: NormalizedLP,
  y: readonly Rational[],
  violations: string[],
  label: string,
  rhs: "objective" | "zero",
): void {
  if (y.length !== lp.constraints.length) {
    violations.push(
      `${label}: expected ${lp.constraints.length} dual multipliers, got ${y.length}`,
    );
    return;
  }
  lp.constraints.forEach((con, i) => {
    if (con.sense === "<=" && y[i]!.isNegative())
      violations.push(`${label}: y[${i}] = ${y[i]} must be >= 0 for a <= constraint`);
    if (con.sense === ">=" && y[i]!.isPositive())
      violations.push(`${label}: y[${i}] = ${y[i]} must be <= 0 for a >= constraint`);
  });
  for (let j = 0; j < lp.numVars; j++) {
    let acc = Rational.ZERO;
    lp.constraints.forEach((con, i) => {
      acc = acc.add(y[i]!.mul(con.coeffs[j]!));
    });
    const target = rhs === "objective" ? lp.c[j]! : Rational.ZERO;
    if (lp.nonnegative[j]) {
      if (acc.cmp(target) < 0)
        violations.push(
          `${label}: dual constraint ${j}: ${acc} < ${target} (must be >= for x[${j}] >= 0)`,
        );
    } else if (!acc.eq(target)) {
      violations.push(
        `${label}: dual constraint ${j}: ${acc} != ${target} (must be = for free x[${j}])`,
      );
    }
  }
}

/**
 * Independently verify a SolveResult against the problem. Every check is an
 * exact rational identity/inequality; a single violation fails the check.
 */
export function checkResult(input: LPInput, result: SolveResult): CheckOutcome {
  const lp = normalize(input);
  const violations: string[] = [];

  switch (result.status) {
    case "optimal": {
      checkPrimalFeasibility(lp, result.primal, violations, "primal");
      checkDualPattern(lp, result.dual, violations, "dual", "objective");
      if (violations.length === 0) {
        const primalObj = dot(lp.c, result.primal);
        const dualObj = dot(
          lp.constraints.map((con) => con.rhs),
          result.dual,
        );
        if (!primalObj.eq(dualObj))
          violations.push(
            `strong duality failed: c.x = ${primalObj} != b.y = ${dualObj}`,
          );
        const reported = lp.flipped ? result.objectiveValue.neg() : result.objectiveValue;
        if (!primalObj.eq(reported))
          violations.push(
            `reported objective ${result.objectiveValue} != c.x = ${
              lp.flipped ? primalObj.neg() : primalObj
            }`,
          );
      }
      break;
    }
    case "infeasible": {
      checkDualPattern(lp, result.farkas, violations, "farkas", "zero");
      if (violations.length === 0) {
        const by = dot(
          lp.constraints.map((con) => con.rhs),
          result.farkas,
        );
        if (!by.isNegative())
          violations.push(`farkas: b.y = ${by} must be < 0`);
      }
      break;
    }
    case "unbounded": {
      checkPrimalFeasibility(lp, result.point, violations, "point");
      if (result.ray.length !== lp.numVars) {
        violations.push(`ray: expected ${lp.numVars} components, got ${result.ray.length}`);
        break;
      }
      lp.nonnegative.forEach((nn, j) => {
        if (nn && result.ray[j]!.isNegative())
          violations.push(`ray: d[${j}] = ${result.ray[j]} must be >= 0`);
      });
      lp.constraints.forEach((con, i) => {
        const ad = dot(con.coeffs, result.ray);
        if (con.sense === "<=" && ad.isPositive())
          violations.push(`ray: constraint ${i}: a.d = ${ad} must be <= 0`);
        if (con.sense === ">=" && ad.isNegative())
          violations.push(`ray: constraint ${i}: a.d = ${ad} must be >= 0`);
        if (con.sense === "=" && !ad.isZero())
          violations.push(`ray: constraint ${i}: a.d = ${ad} must be = 0`);
      });
      const cd = dot(lp.c, result.ray);
      if (!cd.isPositive()) violations.push(`ray: c.d = ${cd} must be > 0`);
      break;
    }
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
