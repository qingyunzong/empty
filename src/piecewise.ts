import { Rational, rat } from "./rational.js";

/** A single breakpoint of a piecewise-linear function. */
export interface Breakpoint {
  readonly t: Rational;
  readonly v: Rational;
}

/**
 * Piecewise-linear function of time, defined by breakpoints with linear
 * interpolation between them. Outside the breakpoint range the function
 * is clamped to the nearest endpoint value (zero slope).
 */
export class PiecewiseLinear {
  readonly points: readonly Breakpoint[];

  constructor(points: readonly Breakpoint[]) {
    if (points.length === 0) throw new Error("PiecewiseLinear: needs at least one point");
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]!;
      const cur = points[i]!;
      if (!prev.t.lt(cur.t)) {
        throw new Error(`PiecewiseLinear: breakpoints must be strictly increasing in t (index ${i})`);
      }
    }
    this.points = points;
  }

  static fromPairs(pairs: ReadonlyArray<readonly [Rational, Rational]>): PiecewiseLinear {
    return new PiecewiseLinear(pairs.map(([t, v]) => ({ t, v })));
  }

  get start(): Rational { return this.points[0]!.t; }
  get end(): Rational { return this.points[this.points.length - 1]!.t; }

  /** Exact value at time t (linear interpolation, clamped outside range). */
  valueAt(t: Rational): Rational {
    const pts = this.points;
    if (t.le(pts[0]!.t)) return pts[0]!.v;
    const last = pts[pts.length - 1]!;
    if (t.ge(last.t)) return last.v;
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1]!;
      const p1 = pts[i]!;
      if (t.le(p1.t)) {
        const span = p1.t.sub(p0.t);
        const frac = t.sub(p0.t).div(span);
        return p0.v.add(p1.v.sub(p0.v).mul(frac));
      }
    }
    return last.v; // unreachable
  }

  /**
   * Slope of the piece containing t. At interior breakpoints the slope of
   * the piece starting at t (right slope) is returned; outside the range
   * the slope is zero.
   */
  slopeAt(t: Rational): Rational {
    const pts = this.points;
    if (t.lt(pts[0]!.t) || t.ge(pts[pts.length - 1]!.t)) return Rational.ZERO;
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1]!;
      const p1 = pts[i]!;
      if (t.lt(p1.t)) {
        return p1.v.sub(p0.v).div(p1.t.sub(p0.t));
      }
    }
    return Rational.ZERO; // unreachable
  }

  /** All breakpoint times strictly inside (from, to), plus the endpoints. */
  cutPoints(from: Rational, to: Rational): Rational[] {
    const cuts: Rational[] = [from];
    for (const p of this.points) {
      if (p.t.gt(from) && p.t.lt(to)) cuts.push(p.t);
    }
    cuts.push(to);
    return cuts;
  }
}

/** Merge and sort ascending a list of rational cut points, removing duplicates. */
export function mergeCuts(lists: ReadonlyArray<readonly Rational[]>): Rational[] {
  const all: Rational[] = [];
  for (const l of lists) all.push(...l);
  all.sort((a, b) => a.cmp(b));
  const out: Rational[] = [];
  for (const t of all) {
    if (out.length === 0 || !out[out.length - 1]!.eq(t)) out.push(t);
  }
  return out;
}

export { rat };
