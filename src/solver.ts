import { Rational, ceilDiv, floorDiv, gcdBig, lcmBig } from "./rational.js";

export interface LiquidInput {
  name: string;
  concentration: Rational;
  /** Non-negative integer cost per unit. */
  cost: bigint;
}

export interface Solution {
  /** Amount of each liquid, aligned with the input order. */
  amounts: number[];
  /** Total integer cost. */
  cost: bigint;
  /** Total units used (1..maxTotal). */
  total: number;
  /** Exact resulting concentration. */
  concentration: Rational;
}

export interface SolveResult {
  status: "optimal" | "infeasible";
  solution: Solution | null;
  /** Number of search nodes visited; the search always runs to completion. */
  nodesExplored: number;
}

/**
 * Exact search over integer amount vectors x with 1 <= sum(x) <= maxTotal and
 * lo <= sum(c_i x_i) / sum(x) <= hi. Objective: minimize total cost, then the
 * lexicographically smallest amount vector (input order).
 *
 * The DFS enumerates vectors in lexicographic order and only replaces the
 * incumbent on a strictly smaller cost, so the first optimum found in lex
 * order is kept. Pruning never discards a vector that could strictly improve
 * the incumbent, hence the search is complete: "infeasible" is only reported
 * after every reachable vector has been ruled out.
 */
export function solve(
  liquids: readonly LiquidInput[],
  lo: Rational,
  hi: Rational,
  maxTotal: number,
): SolveResult {
  return search(liquids, lo, hi, maxTotal, true);
}

/** Plain enumeration of every amount vector (no pruning); used to cross-check `solve`. */
export function bruteForce(
  liquids: readonly LiquidInput[],
  lo: Rational,
  hi: Rational,
  maxTotal: number,
): SolveResult {
  return search(liquids, lo, hi, maxTotal, false);
}

function search(
  liquids: readonly LiquidInput[],
  lo: Rational,
  hi: Rational,
  maxTotal: number,
  usePruning: boolean,
): SolveResult {
  if (liquids.length === 0) throw new Error("at least one liquid is required");
  if (lo.gt(hi)) throw new Error("empty target interval: lo > hi");
  if (!Number.isInteger(maxTotal) || maxTotal < 1) throw new Error("maxTotal must be an integer >= 1");
  for (const l of liquids) {
    if (l.cost < 0n) throw new Error(`negative cost for liquid ${JSON.stringify(l.name)}`);
  }

  const n = liquids.length;
  // Scale everything to integers with a common denominator D:
  //   lo = Lo/D, hi = Hi/D, c_i = w_i/D.
  // Feasibility for a vector with total A and weighted sum S = sum(w_i x_i):
  //   Lo * A <= S <= Hi * A.
  let den = lcmBig(lo.den, hi.den);
  for (const l of liquids) den = lcmBig(den, l.concentration.den);
  const Lo = lo.num * (den / lo.den);
  const Hi = hi.num * (den / hi.den);
  const w = liquids.map((l) => l.concentration.num * (den / l.concentration.den));
  const costs = liquids.map((l) => l.cost);

  // Suffix aggregates over liquids i..n-1.
  const sufMinCost = new Array<bigint>(n + 1).fill(0n);
  const sufWmin = new Array<bigint>(n + 1).fill(0n);
  const sufWmax = new Array<bigint>(n + 1).fill(0n);
  const sufGcd = new Array<bigint>(n + 1).fill(0n);
  for (let i = n - 1; i >= 0; i--) {
    sufMinCost[i] = i + 1 === n ? costs[i] : costs[i] < sufMinCost[i + 1] ? costs[i] : sufMinCost[i + 1];
    sufWmin[i] = i + 1 === n ? w[i] : w[i] < sufWmin[i + 1] ? w[i] : sufWmin[i + 1];
    sufWmax[i] = i + 1 === n ? w[i] : w[i] > sufWmax[i + 1] ? w[i] : sufWmax[i + 1];
    sufGcd[i] = gcdBig(sufGcd[i + 1], w[i]);
  }

  let nodes = 0;
  let best: Solution | null = null;
  const x = new Array<number>(n).fill(0);

  /**
   * Integer interval [yLo, yHi] of additional units y for which the
   * concentration window is still reachable (continuous relaxation), or null.
   *   S + y*wMin <= Hi*(A + y)   and   S + y*wMax >= Lo*(A + y)
   */
  function reachableTotals(
    A: number,
    S: bigint,
    yMin: number,
    yMax: number,
    wMin: bigint,
    wMax: bigint,
  ): [bigint, bigint] | null {
    let yLo = BigInt(yMin);
    let yHi = BigInt(yMax);
    const k1 = wMin - Hi;
    const b1 = Hi * BigInt(A) - S;
    if (k1 > 0n) {
      const t = floorDiv(b1, k1);
      if (t < yHi) yHi = t;
    } else if (k1 < 0n) {
      const t = -floorDiv(b1, -k1); // ceil(b1/k1) with k1 < 0
      if (t > yLo) yLo = t;
    } else if (b1 < 0n) return null;
    const k2 = wMax - Lo;
    const b2 = Lo * BigInt(A) - S;
    if (k2 > 0n) {
      const t = ceilDiv(b2, k2);
      if (t > yLo) yLo = t;
    } else if (k2 < 0n) {
      const t = -ceilDiv(b2, -k2); // floor(b2/k2) with k2 < 0
      if (t < yHi) yHi = t;
    } else if (b2 > 0n) return null;
    return yLo <= yHi ? [yLo, yHi] : null;
  }

  function dfs(i: number, A: number, S: bigint, C: bigint): void {
    nodes++;
    const remaining = maxTotal - A;
    const yMin = A >= 1 ? 0 : 1;
    if (yMin > remaining) return;
    if (usePruning && best !== null) {
      // Additional units cost at least sufMinCost[i] each (0 when none are
      // needed). Equal-cost vectors found later are lexicographically larger,
      // so only a strictly smaller cost is worth exploring.
      const minExtra = A >= 1 ? 0n : sufMinCost[i];
      if (C + minExtra >= best.cost) return;
    }
    if (i === n) {
      if (A >= 1 && Lo * BigInt(A) <= S && S <= Hi * BigInt(A) && (best === null || C < best.cost)) {
        best = {
          amounts: x.slice(),
          cost: C,
          total: A,
          concentration: Rational.of(S, den * BigInt(A)),
        };
      }
      return;
    }
    if (usePruning) {
      const span = reachableTotals(A, S, yMin, remaining, sufWmin[i], sufWmax[i]);
      if (span === null) return;
      const g = sufGcd[i];
      if (g > 1n) {
        // Contributions of the remaining liquids are multiples of g; the
        // target window must contain one (sound over-approximation).
        const low = Lo * (BigInt(A) + span[0]) - S;
        const up = Hi * (BigInt(A) + span[1]) - S;
        if (floorDiv(up, g) < ceilDiv(low, g)) return;
      }
    }
    for (let v = 0; v <= remaining; v++) {
      x[i] = v;
      dfs(i + 1, A + v, S + w[i] * BigInt(v), C + costs[i] * BigInt(v));
    }
    x[i] = 0;
  }

  dfs(0, 0, 0n, 0n);
  return {
    status: best === null ? "infeasible" : "optimal",
    solution: best,
    nodesExplored: nodes,
  };
}
