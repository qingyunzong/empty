/**
 * LP problem definition and normalization.
 *
 * User-facing form (all data exact rationals):
 *   maximize|minimize  c.x
 *   subject to         a_i . x  (<=|>=|=)  b_i      i = 1..m
 *                      x_j >= 0  unless declared free
 *
 * Limits: at most 6 variables and 12 constraints (enforced).
 *
 * Internally everything is converted to the canonical form
 *   maximize c.x  s.t.  A x <= b, x >= 0
 * which is pointed (has a vertex whenever feasible) and admits the
 * textbook duality used by the certificate checker.
 */
import { Rational, R, type RationalLike } from "./rational.js";

export const MAX_VARS = 6;
export const MAX_CONSTRAINTS = 12;

export type Sense = "<=" | ">=" | "=";
export type Direction = "max" | "min";

export interface ConstraintInput {
  coeffs: RationalLike[];
  sense: Sense;
  rhs: RationalLike;
}

export interface LPInput {
  numVars: number;
  objective: RationalLike[];
  direction?: Direction;
  constraints?: ConstraintInput[];
  /** Defaults to all true (x >= 0). Free variables are split internally. */
  nonnegative?: boolean[];
}

/** Problem with exact rationals, objective normalized to maximization. */
export interface NormalizedLP {
  numVars: number;
  c: Rational[];
  constraints: { coeffs: Rational[]; sense: Sense; rhs: Rational }[];
  nonnegative: boolean[];
  /** true when the user asked for min and c was negated. */
  flipped: boolean;
}

export function normalize(input: LPInput): NormalizedLP {
  const { numVars } = input;
  if (!Number.isInteger(numVars) || numVars < 1 || numVars > MAX_VARS) {
    throw new Error(`numVars must be an integer in [1, ${MAX_VARS}], got ${numVars}`);
  }
  const constraints = input.constraints ?? [];
  if (constraints.length > MAX_CONSTRAINTS) {
    throw new Error(`at most ${MAX_CONSTRAINTS} constraints allowed, got ${constraints.length}`);
  }
  if (input.objective.length !== numVars) {
    throw new Error(`objective must have ${numVars} coefficients`);
  }
  const direction: Direction = input.direction ?? "max";
  const flipped = direction === "min";
  const c = input.objective.map((v) => {
    const r = R(v);
    return flipped ? r.neg() : r;
  });
  const nonnegative = input.nonnegative ?? new Array<boolean>(numVars).fill(true);
  if (nonnegative.length !== numVars) {
    throw new Error(`nonnegative must have ${numVars} entries`);
  }
  const cons = constraints.map((con, i) => {
    if (con.coeffs.length !== numVars) {
      throw new Error(`constraint ${i} must have ${numVars} coefficients`);
    }
    if (con.sense !== "<=" && con.sense !== ">=" && con.sense !== "=") {
      throw new Error(`constraint ${i}: bad sense ${String(con.sense)}`);
    }
    return { coeffs: con.coeffs.map(R), sense: con.sense, rhs: R(con.rhs) };
  });
  return { numVars, c, constraints: cons, nonnegative, flipped };
}

/**
 * Canonical form: maximize c.x s.t. A x <= b, x >= 0,
 * plus the maps needed to translate certificates back to the
 * original variables/constraints.
 */
export interface CanonicalLP {
  numVars: number;
  numConstraints: number;
  c: Rational[];
  A: Rational[][];
  b: Rational[];
  /** canonical var j contributes varMap[j].sign * x_j to original var varMap[j].orig */
  varMap: { orig: number; sign: 1 | -1 }[];
  /** canonical row k contributes conMap[k].sign * y_k to original dual conMap[k].orig */
  conMap: { orig: number; sign: 1 | -1 }[];
  flipped: boolean;
}

export function toCanonical(lp: NormalizedLP): CanonicalLP {
  const varMap: { orig: number; sign: 1 | -1 }[] = [];
  for (let j = 0; j < lp.numVars; j++) {
    if (lp.nonnegative[j]) {
      varMap.push({ orig: j, sign: 1 });
    } else {
      varMap.push({ orig: j, sign: 1 });
      varMap.push({ orig: j, sign: -1 });
    }
  }
  const n = varMap.length;
  const c: Rational[] = varMap.map((vm) =>
    vm.sign === 1 ? lp.c[vm.orig]! : lp.c[vm.orig]!.neg(),
  );
  const A: Rational[][] = [];
  const b: Rational[] = [];
  const conMap: { orig: number; sign: 1 | -1 }[] = [];
  const pushRow = (orig: number, sign: 1 | -1, coeffs: Rational[], rhs: Rational) => {
    A.push(
      varMap.map((vm) => {
        const base = coeffs[vm.orig]!;
        const signed = vm.sign === 1 ? base : base.neg();
        return sign === 1 ? signed : signed.neg();
      }),
    );
    b.push(sign === 1 ? rhs : rhs.neg());
    conMap.push({ orig, sign });
  };
  lp.constraints.forEach((con, i) => {
    if (con.sense === "<=") pushRow(i, 1, con.coeffs, con.rhs);
    else if (con.sense === ">=") pushRow(i, -1, con.coeffs, con.rhs);
    else {
      pushRow(i, 1, con.coeffs, con.rhs);
      pushRow(i, -1, con.coeffs, con.rhs);
    }
  });
  void n;
  return {
    numVars: varMap.length,
    numConstraints: A.length,
    c,
    A,
    b,
    varMap,
    conMap,
    flipped: lp.flipped,
  };
}

/** Map a canonical-space vector (primal point or ray) back to original variables. */
export function toOriginalVars(can: CanonicalLP, x: readonly Rational[]): Rational[] {
  const out: Rational[] = [];
  for (let j = 0; j < can.varMap.length; j++) {
    const vm = can.varMap[j]!;
    const v = vm.sign === 1 ? x[j]! : x[j]!.neg();
    out[vm.orig] = (out[vm.orig] ?? Rational.ZERO).add(v);
  }
  return out;
}

/** Map canonical duals (one per canonical row) back to original constraints. */
export function toOriginalDuals(can: CanonicalLP, y: readonly Rational[]): Rational[] {
  const out: Rational[] = [];
  for (let k = 0; k < can.conMap.length; k++) {
    const cm = can.conMap[k]!;
    const v = cm.sign === 1 ? y[k]! : y[k]!.neg();
    out[cm.orig] = (out[cm.orig] ?? Rational.ZERO).add(v);
  }
  return out;
}
