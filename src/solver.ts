/**
 * Exact solver for systems of linear inequalities, equalities and
 * congruences, where every constraint involves at most one variable
 * (a separable system) and each variable ranges over a closed 64-bit
 * interval. All arithmetic is exact bigint arithmetic.
 *
 * For each variable the solution set is
 *     { x in Z : L <= x <= U,  x ≡ r (mod m) }
 * which is output as the minimal step interval { start, end, step, count }
 * with start = smallest solution, end = largest solution, step = m.
 * When the system is infeasible a machine-readable certificate is
 * returned instead, identifying the conflicting constraints.
 */

import { ceilDiv, floorDiv, floorMod, gcd, modInverse } from "./bigintmath.js";
import type { Constraint } from "./parser.js";

export const INT64_MIN = -(1n << 63n);
export const INT64_MAX = (1n << 63n) - 1n;

export interface Domain {
  lo: bigint;
  hi: bigint;
}

export interface StepInterval {
  start: bigint;
  end: bigint;
  step: bigint;
  count: bigint;
}

export interface Bound {
  value: bigint;
  source: string;
}

export type Certificate =
  | { type: "constant-contradiction"; constraint: string; detail: string }
  | { type: "bound-conflict"; variable: string; lower: Bound; upper: Bound }
  | { type: "equality-not-integral"; variable: string; constraint: string; detail: string }
  | {
      type: "congruence-unsolvable";
      variable: string;
      constraint: string;
      modulus: bigint;
      gcd: bigint;
      detail: string;
    }
  | {
      type: "crt-conflict";
      variable: string;
      residue1: bigint;
      modulus1: bigint;
      residue2: bigint;
      modulus2: bigint;
      gcd: bigint;
      detail: string;
    }
  | {
      type: "no-solution-in-range";
      variable: string;
      lower: Bound;
      upper: Bound;
      residue: bigint;
      modulus: bigint;
      detail: string;
    };

export type VarResult =
  | { status: "sat"; solution: StepInterval }
  | { status: "unsat"; certificate: Certificate };

export type SystemResult =
  | { status: "sat"; solutions: Map<string, StepInterval> }
  | { status: "unsat"; variable: string | null; certificate: Certificate };

export class UnsupportedConstraintError extends Error {}

export function validateDomain(name: string, d: Domain): void {
  if (d.lo > d.hi) {
    throw new Error(`domain of '${name}' is empty: [${d.lo}, ${d.hi}]`);
  }
  if (d.lo < INT64_MIN || d.hi > INT64_MAX) {
    throw new Error(
      `domain of '${name}' [${d.lo}, ${d.hi}] exceeds the signed 64-bit range`,
    );
  }
}

/** Solve all constraints that involve the single variable `name`. */
export function solveVariable(
  name: string,
  domain: Domain,
  constraints: Constraint[],
): VarResult {
  const domainSource = `domain [${domain.lo}, ${domain.hi}]`;
  let lower: Bound = { value: domain.lo, source: domainSource };
  let upper: Bound = { value: domain.hi, source: domainSource };
  let residue = 0n;
  let modulus = 1n;

  const boundConflict = (): VarResult => ({
    status: "unsat",
    certificate: { type: "bound-conflict", variable: name, lower, upper },
  });

  for (const c of constraints) {
    const coef = c.expr.coefs.get(name) ?? 0n;
    const konst = c.expr.konst;

    if (c.kind === "ineq") {
      // coef*x + konst <= 0
      if (coef === 0n) {
        if (konst > 0n) {
          return {
            status: "unsat",
            certificate: {
              type: "constant-contradiction",
              constraint: c.raw,
              detail: `constraint reduces to ${konst} <= 0, which is false`,
            },
          };
        }
        continue;
      }
      if (coef > 0n) {
        const bound = floorDiv(-konst, coef);
        if (bound < upper.value) upper = { value: bound, source: c.raw };
      } else {
        const bound = ceilDiv(-konst, coef);
        if (bound > lower.value) lower = { value: bound, source: c.raw };
      }
    } else if (c.kind === "eq") {
      // coef*x + konst == 0
      if (coef === 0n) {
        if (konst !== 0n) {
          return {
            status: "unsat",
            certificate: {
              type: "constant-contradiction",
              constraint: c.raw,
              detail: `constraint reduces to ${konst} == 0, which is false`,
            },
          };
        }
        continue;
      }
      if ((-konst) % coef !== 0n) {
        return {
          status: "unsat",
          certificate: {
            type: "equality-not-integral",
            variable: name,
            constraint: c.raw,
            detail: `requires ${name} = ${-konst}/${coef}, which is not an integer`,
          },
        };
      }
      const x0 = (-konst) / coef;
      if (x0 > lower.value) lower = { value: x0, source: c.raw };
      if (x0 < upper.value) upper = { value: x0, source: c.raw };
    } else {
      // coef*x + konst ≡ 0 (mod c.modulus)
      const m = c.modulus;
      const a = floorMod(coef, m);
      const g = gcd(a, m);
      if (floorMod(konst, g) !== 0n) {
        return {
          status: "unsat",
          certificate: {
            type: "congruence-unsolvable",
            variable: name,
            constraint: c.raw,
            modulus: m,
            gcd: g,
            detail: `${coef}*${name} + ${konst} ≡ 0 (mod ${m}) requires ${konst} ≡ 0 (mod ${g})`,
          },
        };
      }
      const mPrime = m / g;
      if (mPrime === 1n) continue; // congruence is trivially satisfied
      const inv = modInverse(a / g, mPrime);
      if (inv === null) throw new Error("internal error: inverse must exist");
      const r = floorMod(-(konst / g) * inv, mPrime);

      // Generalized CRT: merge  x ≡ residue (mod modulus)  with  x ≡ r (mod mPrime)
      const g2 = gcd(modulus, mPrime);
      if (floorMod(r - residue, g2) !== 0n) {
        return {
          status: "unsat",
          certificate: {
            type: "crt-conflict",
            variable: name,
            residue1: residue,
            modulus1: modulus,
            residue2: r,
            modulus2: mPrime,
            gcd: g2,
            detail: `x ≡ ${residue} (mod ${modulus}) conflicts with x ≡ ${r} (mod ${mPrime}): differ mod ${g2}`,
          },
        };
      }
      const m2Prime = mPrime / g2;
      const inv2 = modInverse(modulus / g2, m2Prime);
      if (inv2 === null) throw new Error("internal error: inverse must exist");
      const t = floorMod(((r - residue) / g2) * inv2, m2Prime);
      residue = floorMod(residue + modulus * t, modulus * m2Prime);
      modulus = modulus * m2Prime;
    }

    if (lower.value > upper.value) return boundConflict();
  }

  if (lower.value > upper.value) return boundConflict();

  const first = lower.value + floorMod(residue - lower.value, modulus);
  if (first > upper.value) {
    return {
      status: "unsat",
      certificate: {
        type: "no-solution-in-range",
        variable: name,
        lower,
        upper,
        residue,
        modulus,
        detail: `no x ≡ ${residue} (mod ${modulus}) inside [${lower.value}, ${upper.value}]`,
      },
    };
  }
  const last = upper.value - floorMod(upper.value - residue, modulus);
  const count = (last - first) / modulus + 1n;
  return { status: "sat", solution: { start: first, end: last, step: modulus, count } };
}

function checkConstantConstraint(c: Constraint): Certificate | null {
  const konst = c.expr.konst;
  if (c.kind === "ineq" && konst > 0n) {
    return {
      type: "constant-contradiction",
      constraint: c.raw,
      detail: `constraint reduces to ${konst} <= 0, which is false`,
    };
  }
  if (c.kind === "eq" && konst !== 0n) {
    return {
      type: "constant-contradiction",
      constraint: c.raw,
      detail: `constraint reduces to ${konst} == 0, which is false`,
    };
  }
  if (c.kind === "cong" && floorMod(konst, c.modulus) !== 0n) {
    return {
      type: "constant-contradiction",
      constraint: c.raw,
      detail: `constraint reduces to ${konst} ≡ 0 (mod ${c.modulus}), which is false`,
    };
  }
  return null;
}

/** Solve a separable system: every constraint may mention at most one variable. */
export function solveSystem(
  variables: ReadonlyMap<string, Domain>,
  constraints: Constraint[],
): SystemResult {
  const byVar = new Map<string, Constraint[]>();
  for (const [v, dom] of variables) {
    validateDomain(v, dom);
    byVar.set(v, []);
  }

  for (const c of constraints) {
    const names = [...c.expr.coefs.keys()];
    if (names.length === 0) {
      const cert = checkConstantConstraint(c);
      if (cert) return { status: "unsat", variable: null, certificate: cert };
      continue;
    }
    if (names.length > 1) {
      throw new UnsupportedConstraintError(
        `constraint involves multiple variables (${names.join(", ")}), ` +
          `only separable constraints are supported: ${c.raw}`,
      );
    }
    const v = names[0]!;
    const list = byVar.get(v);
    if (!list) {
      throw new UnsupportedConstraintError(`unknown variable '${v}' in constraint: ${c.raw}`);
    }
    list.push(c);
  }

  const solutions = new Map<string, StepInterval>();
  for (const [v, dom] of variables) {
    const result = solveVariable(v, dom, byVar.get(v)!);
    if (result.status === "unsat") {
      return { status: "unsat", variable: v, certificate: result.certificate };
    }
    solutions.set(v, result.solution);
  }
  return { status: "sat", solutions };
}
