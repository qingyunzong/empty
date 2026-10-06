import { Fraction } from "./fraction";
import { Line, XY, intersectionPolynomial } from "./bezier";
import { isolateRoots } from "./isolate";
import {
  Poly,
  degree,
  divExact,
  evalAt,
  isZero,
  squareFree,
} from "./poly";

export const MAX_SEGMENTS = 8;
export const DEFAULT_BUDGET = 100_000;
export const DEFAULT_REFINE_BITS = 24;

export interface SolveOptions {
  /** Total budget of exact sign-variation evaluations across all segments. */
  budget?: number;
  /** Isolating intervals are refined to width <= 2^-refineBits. */
  refineBits?: number;
}

export interface RootEntry {
  segment: number;
  multiplicity: number;
  exact: boolean;
  uLo: Fraction;
  uHi: Fraction;
  tLo: Fraction;
  tHi: Fraction;
}

export interface OnLineEntry {
  segment: number;
  tLo: Fraction;
  tHi: Fraction;
}

export interface UnknownEntry {
  segment: number;
  /** Multiplicity any root inside this interval would carry. */
  multiplicity: number;
  uLo: Fraction;
  uHi: Fraction;
  tLo: Fraction;
  tHi: Fraction;
  reason: string;
}

export interface SolveStats {
  budget: number;
  nodesUsed: number;
  refineBits: number;
}

export interface SolveResult {
  roots: RootEntry[];
  onLine: OnLineEntry[];
  unknown: UnknownEntry[];
  stats: SolveStats;
}

/**
 * Solves a piecewise-Bezier curve (1..8 segments, each 2..4 rational
 * control points) against a line. The global parameter is t = segment + u
 * with u in [0, 1]. Roots are reported per segment; a root exactly at a
 * shared joint appears once per adjacent segment.
 */
export function solveCurveLine(
  line: Line,
  segments: XY[][],
  options: SolveOptions = {},
): SolveResult {
  if (segments.length < 1 || segments.length > MAX_SEGMENTS) {
    throw new Error(
      `expected 1..${MAX_SEGMENTS} segments, got ${segments.length}`,
    );
  }
  const budget = options.budget ?? DEFAULT_BUDGET;
  const refineBits = options.refineBits ?? DEFAULT_REFINE_BITS;
  if (budget < 0) throw new Error("budget must be non-negative");

  const result: SolveResult = {
    roots: [],
    onLine: [],
    unknown: [],
    stats: { budget, nodesUsed: 0, refineBits },
  };

  const xPoly: Poly = [Fraction.ZERO, Fraction.ONE];
  const xMinusOne: Poly = [Fraction.ONE.neg(), Fraction.ONE];

  segments.forEach((points, seg) => {
    if (points.length < 2 || points.length > 4) {
      throw new Error(
        `segment ${seg}: expected 2..4 control points, got ${points.length}`,
      );
    }
    const t0 = Fraction.of(seg);
    const t1 = Fraction.of(seg + 1);
    const poly = intersectionPolynomial(points, line);

    if (isZero(poly)) {
      result.onLine.push({ segment: seg, tLo: t0, tHi: t1 });
      return;
    }

    const pushRoot = (
      multiplicity: number,
      uLo: Fraction,
      uHi: Fraction,
    ): void => {
      result.roots.push({
        segment: seg,
        multiplicity,
        exact: uLo.equals(uHi),
        uLo,
        uHi,
        tLo: t0.add(uLo),
        tHi: t0.add(uHi),
      });
    };

    for (const { factor, multiplicity } of squareFree(poly)) {
      let f = factor;
      if (evalAt(f, Fraction.ZERO).isZero()) {
        pushRoot(multiplicity, Fraction.ZERO, Fraction.ZERO);
        f = divExact(f, xPoly);
      }
      if (!isZero(f) && evalAt(f, Fraction.ONE).isZero()) {
        pushRoot(multiplicity, Fraction.ONE, Fraction.ONE);
        f = divExact(f, xMinusOne);
      }
      if (degree(f) < 1) continue;

      const remaining = result.stats.budget - result.stats.nodesUsed;
      const iso = isolateRoots(f, { budget: remaining, refineBits });
      result.stats.nodesUsed += iso.nodesUsed;
      for (const r of iso.roots) pushRoot(multiplicity, r.lo, r.hi);
      for (const u of iso.unknown) {
        result.unknown.push({
          segment: seg,
          multiplicity,
          uLo: u.lo,
          uHi: u.hi,
          tLo: t0.add(u.lo),
          tHi: t0.add(u.hi),
          reason: "budget-exceeded",
        });
      }
    }
  });

  result.roots.sort((p, q) => p.tLo.cmp(q.tLo) || p.tHi.cmp(q.tHi));
  result.unknown.sort((p, q) => p.tLo.cmp(q.tLo) || p.tHi.cmp(q.tHi));
  return result;
}

/** JSON-friendly rendering: exact rationals as "p/q" strings. */
export function resultToJson(result: SolveResult): unknown {
  const interval = (lo: Fraction, hi: Fraction) => ({
    lo: lo.toString(),
    hi: hi.toString(),
  });
  return {
    roots: result.roots.map((r) => ({
      segment: r.segment,
      multiplicity: r.multiplicity,
      exact: r.exact,
      u: interval(r.uLo, r.uHi),
      t: interval(r.tLo, r.tHi),
    })),
    onLine: result.onLine.map((s) => ({
      segment: s.segment,
      t: interval(s.tLo, s.tHi),
    })),
    unknown: result.unknown.map((u) => ({
      segment: u.segment,
      multiplicity: u.multiplicity,
      u: interval(u.uLo, u.uHi),
      t: interval(u.tLo, u.tHi),
      reason: u.reason,
    })),
    stats: {
      budget: result.stats.budget,
      nodesUsed: result.stats.nodesUsed,
      refineBits: result.stats.refineBits,
    },
  };
}
