/**
 * Independent solver based on exact vertex enumeration, used to cross-check
 * the simplex solver. Shares no code with the simplex pivoting logic.
 *
 * Canonical form:  maximize c.x  s.t.  A x <= b, x >= 0.
 * The feasible set is pointed (it lies in the nonnegative orthant), so it is
 * nonempty iff it has a vertex. Vertices are basic solutions: pick n of the
 * m+n constraints (m rows of A plus the n nonnegativity rows), solve the
 * resulting n x n system exactly, keep feasible solutions.
 *
 * Unboundedness is decided exactly by a second enumeration over the
 * (bounded) ray LP:  max c.d  s.t.  A d <= 0, d >= 0, sum d_j <= 1.
 * The LP is unbounded iff that maximum is > 0.
 */
import { Rational, dot } from "./rational.js";
import type { CanonicalLP } from "./lp.js";

export type EnumerationResult =
  | { status: "optimal"; objectiveValue: Rational; primal: Rational[] }
  | { status: "infeasible" }
  | { status: "unbounded"; point: Rational[]; ray: Rational[] }
  | { status: "skipped"; reason: string };

/** Solve an exact n x n system M x = rhs; returns null if singular. */
export function solveSquare(M: Rational[][], rhs: Rational[]): Rational[] | null {
  const n = rhs.length;
  const a: Rational[][] = M.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = -1;
    for (let r = col; r < n; r++) {
      if (!a[r]![col]!.isZero()) {
        piv = r;
        break;
      }
    }
    if (piv === -1) return null;
    [a[col], a[piv]] = [a[piv]!, a[col]!];
    const inv = Rational.ONE.div(a[col]![col]!);
    for (let j = col; j <= n; j++) a[col]![j] = a[col]![j]!.mul(inv);
    for (let r = 0; r < n; r++) {
      if (r === col || a[r]![col]!.isZero()) continue;
      const f = a[r]![col]!;
      for (let j = col; j <= n; j++) a[r]![j] = a[r]![j]!.sub(f.mul(a[col]![j]!));
    }
  }
  return a.map((row) => row[n]!);
}

interface Row {
  a: Rational[];
  b: Rational;
}

function bestVertex(rows: Row[], n: number, c: Rational[], limit: number) {
  const total = rows.length;
  // Guard against combinatorial blow-up.
  let combos = 1;
  for (let i = 0; i < n; i++) combos = (combos * (total - i)) / (i + 1);
  if (combos > limit) return { skipped: true as const, combos };

  const idx: number[] = Array.from({ length: n }, (_, i) => i);
  let best: { value: Rational; x: Rational[] } | null = null;
  let feasibleFound = false;

  for (;;) {
    const M: Rational[][] = [];
    const rhs: Rational[] = [];
    for (const k of idx) {
      M.push(rows[k]!.a);
      rhs.push(rows[k]!.b);
    }
    const x = solveSquare(M, rhs);
    if (x !== null) {
      let feasible = true;
      for (const row of rows) {
        if (dot(row.a, x).cmp(row.b) > 0) {
          feasible = false;
          break;
        }
      }
      if (feasible) {
        feasibleFound = true;
        const value = dot(c, x);
        if (best === null || value.cmp(best.value) > 0) best = { value, x };
      }
    }
    // Next combination (lexicographic).
    let i = n - 1;
    while (i >= 0 && idx[i] === total - n + i) i--;
    if (i < 0) break;
    idx[i]!++;
    for (let j = i + 1; j < n; j++) idx[j] = idx[j - 1]! + 1;
  }
  return { skipped: false as const, feasibleFound, best };
}

export function solveByEnumeration(
  lp: CanonicalLP,
  combinationLimit = 200_000,
): EnumerationResult {
  const n = lp.numVars;
  const rows: Row[] = [];
  for (let i = 0; i < lp.numConstraints; i++) rows.push({ a: lp.A[i]!, b: lp.b[i]! });
  for (let j = 0; j < n; j++) {
    const a = new Array<Rational>(n).fill(Rational.ZERO);
    a[j] = Rational.ONE.neg(); // -x_j <= 0  <=>  x_j >= 0
    rows.push({ a, b: Rational.ZERO });
  }

  const main = bestVertex(rows, n, lp.c, combinationLimit);
  if (main.skipped) {
    return { status: "skipped", reason: `${main.combos} combinations exceed limit` };
  }
  if (!main.feasibleFound) return { status: "infeasible" };

  // Exact unboundedness test via the bounded ray LP.
  const rayRows: Row[] = [];
  for (let i = 0; i < lp.numConstraints; i++)
    rayRows.push({ a: lp.A[i]!, b: Rational.ZERO });
  for (let j = 0; j < n; j++) {
    const a = new Array<Rational>(n).fill(Rational.ZERO);
    a[j] = Rational.ONE.neg();
    rayRows.push({ a, b: Rational.ZERO });
  }
  rayRows.push({ a: new Array<Rational>(n).fill(Rational.ONE), b: Rational.ONE });

  const ray = bestVertex(rayRows, n, lp.c, combinationLimit);
  if (ray.skipped) {
    return { status: "skipped", reason: `ray LP: ${ray.combos} combinations exceed limit` };
  }
  if (ray.best !== null && ray.best.value.isPositive()) {
    return { status: "unbounded", point: main.best!.x, ray: ray.best.x };
  }
  return { status: "optimal", objectiveValue: main.best!.value, primal: main.best!.x };
}
