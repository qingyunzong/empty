/**
 * exact-lp: exact rational LP solver with certificates.
 *
 *   import { solve, checkResult } from "exact-lp";
 *   const result = solve({ numVars: 2, objective: [3, 2], ... });
 *   checkResult(problem, result); // { ok: true }
 */
import {
  normalize,
  toCanonical,
  toOriginalVars,
  toOriginalDuals,
  type LPInput,
} from "./lp.js";
import { solveCanonical } from "./simplex.js";
import type { SolveResult } from "./certificates.js";

export { Rational, R, dot, type RationalLike } from "./rational.js";
export {
  normalize,
  toCanonical,
  MAX_VARS,
  MAX_CONSTRAINTS,
  type LPInput,
  type ConstraintInput,
  type Sense,
  type Direction,
  type NormalizedLP,
  type CanonicalLP,
} from "./lp.js";
export { solveCanonical, type CanonicalResult } from "./simplex.js";
export { checkResult, type SolveResult, type CheckOutcome } from "./certificates.js";
export { solveByEnumeration, solveSquare, type EnumerationResult } from "./enumerate.js";

/** Solve an LP exactly; the result always carries a verifiable certificate. */
export function solve(input: LPInput): SolveResult {
  const lp = normalize(input);
  const can = toCanonical(lp);
  const res = solveCanonical(can);
  switch (res.status) {
    case "optimal": {
      const value = lp.flipped ? res.objectiveValue.neg() : res.objectiveValue;
      return {
        status: "optimal",
        objectiveValue: value,
        primal: toOriginalVars(can, res.primal),
        dual: toOriginalDuals(can, res.dual),
      };
    }
    case "infeasible":
      return { status: "infeasible", farkas: toOriginalDuals(can, res.farkas) };
    case "unbounded":
      return {
        status: "unbounded",
        point: toOriginalVars(can, res.point),
        ray: toOriginalVars(can, res.ray),
      };
  }
}
