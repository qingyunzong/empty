/**
 * Exact axis-aligned bounding boxes for rational quadratic Bezier curves
 *
 *   P(t) = ( sum_i w_i B_i(t) p_i ) / ( sum_i w_i B_i(t) ),  t in [0, 1]
 *
 * with positive rational weights. Interior extrema are located by solving
 * d/dt P(t) = 0 per axis, whose numerator is a quadratic polynomial with
 * integer coefficients. Irrational critical parameters are reported as
 * rational root-isolation intervals, and coordinate values are enclosed
 * by exact rational interval arithmetic, so the reported box is a
 * provable enclosure of the true AABB.
 */
import { Rat } from "./rat.js";
import {
  evalRationalBezierInterval,
  isolateQuadraticRoots,
  type Interval,
} from "./interval.js";

export interface Vec2 {
  x: Rat;
  y: Rat;
}

export interface RationalQuadraticBezier {
  readonly p0: Vec2;
  readonly p1: Vec2;
  readonly p2: Vec2;
  readonly w0: Rat;
  readonly w1: Rat;
  readonly w2: Rat;
}

export type ParamInterval = Interval;
export type ValueInterval = Interval;

export interface Extremum {
  readonly axis: "x" | "y";
  /** Isolating interval for the critical parameter t* in (0, 1). */
  readonly param: ParamInterval;
  /** Enclosure of the coordinate value at t*. */
  readonly value: ValueInterval;
}

export interface AxisAABB {
  /** The true minimum lies in [min.lo, min.hi]. */
  readonly min: ValueInterval;
  /** The true maximum lies in [max.lo, max.hi]. */
  readonly max: ValueInterval;
}

export interface AABB2D {
  readonly x: AxisAABB;
  readonly y: AxisAABB;
  /** All interior critical points used to derive the box. */
  readonly extrema: readonly Extremum[];
  /** Isolation tolerance actually used. */
  readonly eps: Rat;
}

export const DEFAULT_EPS: Rat = Rat.of(1n, 1n << 20n);

export function vec2(x: Rat, y: Rat): Vec2 {
  return { x, y };
}

export function makeCurve(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  w0: Rat = Rat.ONE,
  w1: Rat = Rat.ONE,
  w2: Rat = Rat.ONE,
): RationalQuadraticBezier {
  for (const [name, w] of [["w0", w0], ["w1", w1], ["w2", w2]] as const) {
    if (w.sign() <= 0) throw new Error(`makeCurve: ${name} must be positive`);
  }
  return { p0, p1, p2, w0, w1, w2 };
}

/** Exact evaluation of the curve at a rational parameter t. */
export function evaluate(curve: RationalQuadraticBezier, t: Rat): Vec2 {
  const one = Rat.ONE;
  const u = one.sub(t);
  const b0 = u.mul(u);
  const b1 = t.mul(u).mul(Rat.of(2n));
  const b2 = t.mul(t);
  const basis = [b0, b1, b2];
  const weights = [curve.w0, curve.w1, curve.w2];
  const pts = [curve.p0, curve.p1, curve.p2];

  let den = Rat.ZERO;
  let nx = Rat.ZERO;
  let ny = Rat.ZERO;
  for (let i = 0; i < 3; i++) {
    const wb = weights[i]!.mul(basis[i]!);
    den = den.add(wb);
    nx = nx.add(wb.mul(pts[i]!.x));
    ny = ny.add(wb.mul(pts[i]!.y));
  }
  return { x: nx.div(den), y: ny.div(den) };
}

/** Bernstein coefficients of the denominator (the weights). */
function denominatorCoeffs(curve: RationalQuadraticBezier): [Rat, Rat, Rat] {
  return [curve.w0, curve.w1, curve.w2];
}

/** Bernstein coefficients of the weighted numerator for one axis. */
function numeratorCoeffs(
  curve: RationalQuadraticBezier,
  axis: "x" | "y",
): [Rat, Rat, Rat] {
  return [
    curve.w0.mul(curve.p0[axis]),
    curve.w1.mul(curve.p1[axis]),
    curve.w2.mul(curve.p2[axis]),
  ];
}

/**
 * Power-basis coefficients [c0, c1, c2] of the derivative numerator
 * N'*D - N*D' given Bernstein coefficients of N and D. Exact rationals.
 */
function derivativeNumeratorPower(
  nc: readonly [Rat, Rat, Rat],
  dc: readonly [Rat, Rat, Rat],
): [Rat, Rat, Rat] {
  const two = Rat.of(2n);
  // Bernstein -> power: P(t) = p0 + 2(p1-p0) t + (p0 - 2 p1 + p2) t^2
  const toPower = (b: readonly [Rat, Rat, Rat]): [Rat, Rat, Rat] => [
    b[0],
    b[1].sub(b[0]).mul(two),
    b[0].sub(b[1].mul(two)).add(b[2]),
  ];
  const [n0, n1, n2] = toPower(nc);
  const [d0, d1, d2] = toPower(dc);
  // (N' D - N D'): the t^3 terms cancel; result is quadratic.
  const c0 = n1!.mul(d0!).sub(n0!.mul(d1!));
  const c1 = n2!.mul(d0!).sub(n0!.mul(d2!)).mul(two);
  const c2 = n2!.mul(d1!).sub(n1!.mul(d2!));
  return [c0, c1, c2];
}

/** Scale rational coefficients to BigInt by their denominators' product. */
function toBigIntCoeffs(c: readonly [Rat, Rat, Rat]): [bigint, bigint, bigint] {
  const l = c[0]!.den * c[1]!.den * c[2]!.den;
  return [c[0]!.num * (l / c[0]!.den), c[1]!.num * (l / c[1]!.den), c[2]!.num * (l / c[2]!.den)];
}

/**
 * Compute the exact AABB of a rational quadratic Bezier curve.
 *
 * For each axis the result reports a rational interval guaranteed to
 * contain the true minimum / maximum. Interior critical parameters are
 * isolated to width <= eps and their coordinate values are enclosed via
 * exact Bernstein interval arithmetic, so for every t in [0, 1]:
 *
 *   axis.min.lo <= P(t).axis <= axis.max.hi
 *
 * which is precisely the verifiable containment guarantee.
 */
export function rationalQuadraticAABB(
  curve: RationalQuadraticBezier,
  eps: Rat = DEFAULT_EPS,
): AABB2D {
  if (eps.sign() <= 0) throw new Error("rationalQuadraticAABB: eps must be positive");
  const dc = denominatorCoeffs(curve);
  const extrema: Extremum[] = [];
  const axes = {} as Record<"x" | "y", AxisAABB>;

  for (const axis of ["x", "y"] as const) {
    const nc = numeratorCoeffs(curve, axis);
    const [c0, c1, c2] = derivativeNumeratorPower(nc, dc);
    const [k0, k1, k2] = toBigIntCoeffs([c0, c1, c2]);

    // Candidates: endpoints (exact) plus every interior critical point.
    const candidates: ValueInterval[] = [
      { lo: curve.p0[axis], hi: curve.p0[axis] },
      { lo: curve.p2[axis], hi: curve.p2[axis] },
    ];

    if (k2 !== 0n || k1 !== 0n) {
      // isolateQuadraticRoots(a, b, c) solves a*t^2 + b*t + c = 0.
      for (const bracket of isolateQuadraticRoots(k2, k1, k0, eps)) {
        const value = evalRationalBezierInterval(nc, dc, bracket.lo, bracket.hi);
        candidates.push(value);
        extrema.push({ axis, param: bracket, value });
      }
    }

    const minLo = candidates.reduce((m, iv) => Rat.min(m, iv.lo), candidates[0]!.lo);
    const minHi = candidates.reduce((m, iv) => Rat.min(m, iv.hi), candidates[0]!.hi);
    const maxLo = candidates.reduce((m, iv) => Rat.max(m, iv.lo), candidates[0]!.lo);
    const maxHi = candidates.reduce((m, iv) => Rat.max(m, iv.hi), candidates[0]!.hi);
    axes[axis] = { min: { lo: minLo, hi: minHi }, max: { lo: maxLo, hi: maxHi } };
  }

  return { x: axes.x, y: axes.y, extrema, eps };
}

/** Guaranteed containing box: P(t).axis in [lo(axis), hi(axis)] for all t. */
export function containingBox(box: AABB2D): { xMin: Rat; yMin: Rat; xMax: Rat; yMax: Rat } {
  return {
    xMin: box.x.min.lo,
    yMin: box.y.min.lo,
    xMax: box.x.max.hi,
    yMax: box.y.max.hi,
  };
}
