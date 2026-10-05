/**
 * Exact two-phase primal simplex (dictionary form) with Bland's rule.
 * All arithmetic is exact rational arithmetic; termination is guaranteed
 * by Bland's least-index rule (no cycling, no tolerances).
 *
 * Solves the canonical LP:  maximize c.x  s.t.  A x <= b, x >= 0.
 *
 * Certificates produced (all exact, independently checkable):
 *  - optimal:     primal vertex x*, duals y* (y = -reduced cost of slacks)
 *  - infeasible:  Farkas ray y >= 0 with A^T y >= 0, b.y < 0 (from phase I)
 *  - unbounded:   feasible point x0 and ray d >= 0, A d <= 0, c.d > 0
 */
import { Rational } from "./rational.js";
import type { CanonicalLP } from "./lp.js";

export type CanonicalResult =
  | { status: "optimal"; objectiveValue: Rational; primal: Rational[]; dual: Rational[] }
  | { status: "infeasible"; farkas: Rational[] }
  | { status: "unbounded"; point: Rational[]; ray: Rational[] };

interface Dictionary {
  basis: number[]; // variable indices, length m
  nonbasis: number[]; // variable indices
  b: Rational[]; // constants, x_B = b - A x_N
  A: Rational[][]; // m x |nonbasis|
  obj: Rational[]; // objective coeffs over nonbasis: zeta = v + obj . x_N
  v: Rational;
}

function pivot(d: Dictionary, l: number, e: number): void {
  const leaving = d.basis[l]!;
  const entering = d.nonbasis[e]!;
  const ale = d.A[l]![e]!;
  if (ale.isZero()) throw new Error("pivot: zero pivot element");

  // New row for the entering variable.
  const newRowB = d.b[l]!.div(ale);
  const newRow = d.A[l]!.map((a) => a.div(ale)); // position e becomes 1/ale
  newRow[e] = Rational.ONE.div(ale);

  const m = d.basis.length;
  const width = d.nonbasis.length;
  const objE = d.obj[e]!;

  // Update remaining rows and the objective, using old column e values.
  const colE: Rational[] = [];
  for (let i = 0; i < m; i++) colE.push(d.A[i]![e]!);

  for (let i = 0; i < m; i++) {
    if (i === l) continue;
    const aie = colE[i]!;
    if (aie.isZero()) continue; // row unchanged
    d.b[i] = d.b[i]!.sub(aie.mul(newRowB));
    for (let j = 0; j < width; j++) {
      if (j === e) continue;
      d.A[i]![j] = d.A[i]![j]!.sub(aie.mul(newRow[j]!));
    }
    d.A[i]![e] = aie.neg().div(ale);
  }

  d.v = d.v.add(objE.mul(newRowB));
  for (let j = 0; j < width; j++) {
    if (j === e) continue;
    d.obj[j] = d.obj[j]!.sub(objE.mul(newRow[j]!));
  }
  d.obj[e] = objE.neg().div(ale);

  d.A[l] = newRow;
  d.b[l] = newRowB;
  d.basis[l] = entering;
  d.nonbasis[e] = leaving;
}

/** Bland's rule: smallest-index nonbasic variable with positive reduced cost. */
function chooseEntering(d: Dictionary): number {
  let best = -1;
  let bestVar = Infinity;
  for (let j = 0; j < d.nonbasis.length; j++) {
    if (d.obj[j]!.isPositive() && d.nonbasis[j]! < bestVar) {
      bestVar = d.nonbasis[j]!;
      best = j;
    }
  }
  return best;
}

/**
 * Bland's rule leaving row: min ratio b_i / A_ie over A_ie > 0,
 * ties broken by smallest basic variable index. Returns -1 if unbounded.
 */
function chooseLeaving(d: Dictionary, e: number): number {
  let best = -1;
  let bestRatio: Rational | null = null;
  let bestVar = Infinity;
  for (let i = 0; i < d.basis.length; i++) {
    const aie = d.A[i]![e]!;
    if (!aie.isPositive()) continue;
    const ratio = d.b[i]!.div(aie);
    const bv = d.basis[i]!;
    if (
      best === -1 ||
      ratio.cmp(bestRatio!) < 0 ||
      (ratio.cmp(bestRatio!) === 0 && bv < bestVar)
    ) {
      best = i;
      bestRatio = ratio;
      bestVar = bv;
    }
  }
  return best;
}

export function solveCanonical(lp: CanonicalLP): CanonicalResult {
  const n = lp.numVars;
  const m = lp.numConstraints;
  const slackOf = (i: number) => n + i;
  const artificial = n + m;

  const d: Dictionary = {
    basis: [],
    nonbasis: [],
    b: [],
    A: [],
    obj: [],
    v: Rational.ZERO,
  };
  for (let j = 0; j < n; j++) d.nonbasis.push(j);
  for (let i = 0; i < m; i++) {
    d.basis.push(slackOf(i));
    d.b.push(lp.b[i]!);
    d.A.push(lp.A[i]!.slice());
  }

  // ---- Phase I: find a feasible dictionary (or prove none exists). ----
  let mostNeg = -1;
  for (let i = 0; i < m; i++) {
    if (d.b[i]!.isNegative() && (mostNeg === -1 || d.b[i]!.cmp(d.b[mostNeg]!) < 0)) {
      mostNeg = i;
    }
  }

  if (mostNeg !== -1) {
    // Add artificial variable x0 with column -1; objective: maximize -x0.
    d.nonbasis.push(artificial);
    for (let i = 0; i < m; i++) d.A[i]!.push(Rational.ONE.neg());
    d.obj = d.nonbasis.map((v) => (v === artificial ? Rational.ONE.neg() : Rational.ZERO));
    d.v = Rational.ZERO;
    // Forced pivot: x0 enters, most-infeasible row leaves -> dictionary feasible.
    pivot(d, mostNeg, d.nonbasis.indexOf(artificial));

    for (;;) {
      const e = chooseEntering(d);
      if (e === -1) break;
      const l = chooseLeaving(d, e);
      if (l === -1) throw new Error("phase I unbounded (impossible)");
      pivot(d, l, e);
    }

    if (d.v.isNegative()) {
      // Infeasible. Farkas certificate: y_i = -(coefficient of slack i).
      const farkas: Rational[] = [];
      for (let i = 0; i < m; i++) {
        const pos = d.nonbasis.indexOf(slackOf(i));
        const y = pos === -1 ? Rational.ZERO : d.obj[pos]!.neg();
        farkas.push(y);
      }
      return { status: "infeasible", farkas };
    }

    // Drive the artificial variable out of the basis if it lingers at 0.
    const aRow = d.basis.indexOf(artificial);
    if (aRow !== -1) {
      let pivoted = false;
      for (let j = 0; j < d.nonbasis.length; j++) {
        if (d.nonbasis[j] !== artificial && !d.A[aRow]![j]!.isZero()) {
          pivot(d, aRow, j); // b[aRow] = 0, so feasibility is preserved
          pivoted = true;
          break;
        }
      }
      if (!pivoted) {
        // Row is identically zero: redundant constraint, drop it.
        d.basis.splice(aRow, 1);
        d.b.splice(aRow, 1);
        d.A.splice(aRow, 1);
      }
    }
    // Remove the artificial column entirely (it stays nonbasic at 0).
    const aCol = d.nonbasis.indexOf(artificial);
    if (aCol !== -1) {
      d.nonbasis.splice(aCol, 1);
      for (const row of d.A) row.splice(aCol, 1);
    }
  }

  // ---- Phase II: optimize the true objective. ----
  const costOf = (v: number): Rational => (v < n ? lp.c[v]! : Rational.ZERO);
  d.v = Rational.ZERO;
  for (let i = 0; i < d.basis.length; i++) {
    d.v = d.v.add(costOf(d.basis[i]!).mul(d.b[i]!));
  }
  d.obj = d.nonbasis.map((nv, j) => {
    let coeff = costOf(nv);
    for (let i = 0; i < d.basis.length; i++) {
      coeff = coeff.sub(costOf(d.basis[i]!).mul(d.A[i]![j]!));
    }
    return coeff;
  });

  for (;;) {
    const e = chooseEntering(d);
    if (e === -1) {
      // Optimal. Primal: basic feasible solution. Dual: y = -cbar(slacks).
      const primal: Rational[] = new Array<Rational>(n).fill(Rational.ZERO);
      for (let i = 0; i < d.basis.length; i++) {
        if (d.basis[i]! < n) primal[d.basis[i]!] = d.b[i]!;
      }
      const dual: Rational[] = [];
      for (let i = 0; i < m; i++) {
        const pos = d.nonbasis.indexOf(slackOf(i));
        dual.push(pos === -1 ? Rational.ZERO : d.obj[pos]!.neg());
      }
      return { status: "optimal", objectiveValue: d.v, primal, dual };
    }
    const l = chooseLeaving(d, e);
    if (l === -1) {
      // Unbounded: ray from entering column, point = current bfs.
      const point: Rational[] = new Array<Rational>(n).fill(Rational.ZERO);
      for (let i = 0; i < d.basis.length; i++) {
        if (d.basis[i]! < n) point[d.basis[i]!] = d.b[i]!;
      }
      const rayFull = new Map<number, Rational>();
      const enteringVar = d.nonbasis[e]!;
      rayFull.set(enteringVar, Rational.ONE);
      for (let i = 0; i < d.basis.length; i++) {
        const coeff = d.A[i]![e]!;
        if (!coeff.isZero()) rayFull.set(d.basis[i]!, coeff.neg());
      }
      const ray: Rational[] = new Array<Rational>(n).fill(Rational.ZERO);
      for (const [v, val] of rayFull) {
        if (v < n) ray[v] = val;
      }
      return { status: "unbounded", point, ray };
    }
    pivot(d, l, e);
  }
}
