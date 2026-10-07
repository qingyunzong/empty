import { Fraction, RationalLike } from "./fraction.js";
import {
  Interval,
  ivClamp,
  ivContainsValue,
  ivContainsZero,
  ivDiv,
  ivPoint,
  ivUnion,
} from "./interval.js";
import { Poly, polyDer, polyEvalInterval, polyMul, polySub } from "./polynomial.js";
import { isolateRoots } from "./isolate.js";

export interface Vec2Like {
  x: RationalLike;
  y: RationalLike;
}

export type Axis = "x" | "y";

export interface CertifiedExtremum {
  axis: Axis;
  kind: "endpoint" | "interior";
  /** Certified parameter interval: rational root-isolation bounds containing t*. */
  t: Interval;
  /** Certified rational enclosure of the coordinate value over t. */
  value: Interval;
}

export interface RationalQuadraticAABB {
  x: Interval;
  y: Interval;
  extrema: CertifiedExtremum[];
}

export interface AABBOptions {
  /**
   * Bits of precision used for rational root isolation (default 256).
   * Interior extremum parameter intervals have width <= 2^-precisionBits.
   */
  precisionBits?: number;
}

class NeedsRefinement extends Error {}

/** Power-basis coefficients of c0(1-t)^2 + 2 c1 (1-t) t + c2 t^2. */
function bernsteinPowerCoeffs(c0: Fraction, c1: Fraction, c2: Fraction): Poly {
  const two = Fraction.TWO;
  return [c0, c1.mul(two).sub(c0.mul(two)), c0.sub(c1.mul(two)).add(c2)];
}

function coordinatePolynomials(
  vals: [Fraction, Fraction, Fraction],
  w: [Fraction, Fraction, Fraction],
): { n: Poly; d: Poly } {
  return {
    n: bernsteinPowerCoeffs(vals[0].mul(w[0]), vals[1].mul(w[1]), vals[2].mul(w[2])),
    d: bernsteinPowerCoeffs(w[0], w[1], w[2]),
  };
}

function parseWeights(
  weights: [RationalLike, RationalLike, RationalLike],
): [Fraction, Fraction, Fraction] {
  const w = weights.map(Fraction.of) as [Fraction, Fraction, Fraction];
  w.forEach((wi, i) => {
    if (wi.sign() <= 0) {
      throw new RangeError(`weight w${i} must be a positive rational, got ${wi}`);
    }
  });
  return w;
}

/**
 * Exact derivative numerator N'(t) D(t) - N(t) D'(t) (degree <= 2) of one
 * coordinate of the rational quadratic Bezier curve. Its roots in (0, 1) are
 * exactly the interior extremum parameters of that coordinate.
 */
export function derivativeNumerator(
  p0: Vec2Like,
  p1: Vec2Like,
  p2: Vec2Like,
  weights: [RationalLike, RationalLike, RationalLike],
  axis: Axis,
): Poly {
  const w = parseWeights(weights);
  const pts = [p0, p1, p2].map((p) => Fraction.of(p[axis])) as [
    Fraction,
    Fraction,
    Fraction,
  ];
  const { n, d } = coordinatePolynomials(pts, w);
  return polySub(polyMul(polyDer(n), d), polyMul(n, polyDer(d)));
}

function axisExtrema(
  axis: Axis,
  vals: [Fraction, Fraction, Fraction],
  w: [Fraction, Fraction, Fraction],
  precisionBits: number,
): CertifiedExtremum[] {
  const { n, d } = coordinatePolynomials(vals, w);
  const m = polySub(polyMul(polyDer(n), d), polyMul(n, polyDer(d)));
  const candidates: Array<{ kind: "endpoint" | "interior"; t: Interval }> = [
    { kind: "endpoint", t: ivPoint(Fraction.ZERO) },
    { kind: "endpoint", t: ivPoint(Fraction.ONE) },
  ];
  for (const root of isolateRoots(m, precisionBits)) {
    const t = ivClamp(root, Fraction.ZERO, Fraction.ONE);
    if (t) candidates.push({ kind: "interior", t });
  }
  return candidates.map(({ kind, t }) => {
    const dInterval = polyEvalInterval(d, t);
    if (ivContainsZero(dInterval)) throw new NeedsRefinement();
    const value = ivDiv(polyEvalInterval(n, t), dInterval);
    return { axis, kind, t, value };
  });
}

/**
 * Exact certified axis-aligned bounding box of the rational quadratic Bezier
 * curve B(t) = sum(w_i B_i(t) P_i) / sum(w_i B_i(t)), t in [0, 1], with
 * positive rational weights. All bounds are exact rationals; interior extrema
 * are reported as rational root-isolation parameter intervals.
 */
export function rationalQuadraticAABB(
  p0: Vec2Like,
  p1: Vec2Like,
  p2: Vec2Like,
  weights: [RationalLike, RationalLike, RationalLike],
  options: AABBOptions = {},
): RationalQuadraticAABB {
  const pts = [p0, p1, p2].map((p) => ({ x: Fraction.of(p.x), y: Fraction.of(p.y) }));
  const w = parseWeights(weights);
  let precisionBits = Math.max(8, Math.floor(options.precisionBits ?? 256));
  for (;;) {
    try {
      const extrema: CertifiedExtremum[] = [
        ...axisExtrema("x", [pts[0].x, pts[1].x, pts[2].x], w, precisionBits),
        ...axisExtrema("y", [pts[0].y, pts[1].y, pts[2].y], w, precisionBits),
      ];
      const union = (axis: Axis) =>
        extrema
          .filter((e) => e.axis === axis)
          .map((e) => e.value)
          .reduce(ivUnion);
      return { x: union("x"), y: union("y"), extrema };
    } catch (e) {
      if (e instanceof NeedsRefinement) {
        if (precisionBits > 1 << 20) throw new Error("root isolation failed to converge");
        precisionBits *= 2;
        continue;
      }
      throw e;
    }
  }
}

/** Exact evaluation of the curve at a rational parameter t. */
export function evaluateRationalQuadratic(
  p0: Vec2Like,
  p1: Vec2Like,
  p2: Vec2Like,
  weights: [RationalLike, RationalLike, RationalLike],
  t: RationalLike,
): { x: Fraction; y: Fraction } {
  const w = parseWeights(weights);
  const pts = [p0, p1, p2].map((p) => ({ x: Fraction.of(p.x), y: Fraction.of(p.y) }));
  const tt = Fraction.of(t);
  const u = Fraction.ONE.sub(tt);
  const b = [u.mul(u), Fraction.TWO.mul(u).mul(tt), tt.mul(tt)];
  const d = b[0].mul(w[0]).add(b[1].mul(w[1])).add(b[2].mul(w[2]));
  const coord = (axis: Axis): Fraction =>
    b[0]
      .mul(w[0])
      .mul(pts[0][axis])
      .add(b[1].mul(w[1]).mul(pts[1][axis]))
      .add(b[2].mul(w[2]).mul(pts[2][axis]))
      .div(d);
  return { x: coord("x"), y: coord("y") };
}

export function aabbContains(
  box: RationalQuadraticAABB,
  x: Fraction,
  y: Fraction,
): boolean {
  return ivContainsValue(box.x, x) && ivContainsValue(box.y, y);
}
