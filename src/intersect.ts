import { ExactCoord, makeExactCoord, rationalCoord } from './algebraic.js';
import { gcd3, isqrt, lcm } from './bigint-util.js';
import { Conic, ConicInput, assertEllipse, makeConic } from './conic.js';
import { RationalInterval, ivAdd, ivConst, ivScale, makeInterval } from './interval.js';
import { Line, LineInput, makeLine } from './line.js';
import { Rational } from './rational.js';

/**
 * Restriction of the conic to the line: an integer quadratic
 *     a2 t^2 + a1 t + a0 = 0
 * where t is x (non-vertical line, y = alpha*x + beta) or y (vertical line x = x0).
 */
export interface UnivariateQuadratic {
  readonly variable: 'x' | 'y';
  readonly a2: bigint;
  readonly a1: bigint;
  readonly a0: bigint;
  readonly alpha: Rational | null;
  readonly beta: Rational | null;
  readonly x0: Rational | null;
}

/** Exact algebraic coordinate together with a rational isolating interval. */
export interface IsolatedCoord extends ExactCoord {
  readonly interval: RationalInterval;
}

export interface SecantPoint {
  readonly x: IsolatedCoord;
  readonly y: IsolatedCoord;
}

export type IntersectionResult =
  | { readonly kind: 'none'; readonly discriminant: bigint; readonly quadratic: UnivariateQuadratic }
  | {
      readonly kind: 'tangent';
      readonly point: { readonly x: Rational; readonly y: Rational };
      readonly quadratic: UnivariateQuadratic;
    }
  | {
      readonly kind: 'secant';
      readonly discriminant: bigint;
      readonly points: readonly [SecantPoint, SecantPoint];
      readonly quadratic: UnivariateQuadratic;
    };

export interface IntersectOptions {
  /** Bisection steps used to tighten isolating intervals (default 64). */
  readonly isolationIterations?: number;
}

/** Substitutes the line into the conic, yielding an exact integer quadratic. */
export function substituteLine(conic: Conic, line: Line): UnivariateQuadratic {
  const { A, B, C, D, E, F } = conic;
  let q2: Rational;
  let q1: Rational;
  let q0: Rational;
  let variable: 'x' | 'y';
  let alpha: Rational | null = null;
  let beta: Rational | null = null;
  let x0: Rational | null = null;

  if (!line.b.isZero()) {
    // y = alpha x + beta
    variable = 'x';
    alpha = line.a.neg().div(line.b);
    beta = line.c.neg().div(line.b);
    q2 = A.add(B.mul(alpha)).add(C.mul(alpha).mul(alpha));
    q1 = B.mul(beta).add(C.mul(alpha).mul(beta).mul(2n)).add(D).add(E.mul(alpha));
    q0 = C.mul(beta).mul(beta).add(E.mul(beta)).add(F);
  } else {
    // vertical line x = x0
    variable = 'y';
    x0 = line.c.neg().div(line.a);
    q2 = C;
    q1 = B.mul(x0).add(E);
    q0 = A.mul(x0).mul(x0).add(D.mul(x0)).add(F);
  }

  // Clear denominators and normalize to a primitive integer quadratic with a2 > 0.
  const den = lcm(lcm(q2.den, q1.den), q0.den);
  let a2 = q2.num * (den / q2.den);
  let a1 = q1.num * (den / q1.den);
  let a0 = q0.num * (den / q0.den);
  const g = gcd3(a2, a1, a0);
  if (g > 1n) {
    a2 /= g;
    a1 /= g;
    a0 /= g;
  }
  if (a2 < 0n) {
    a2 = -a2;
    a1 = -a1;
    a0 = -a0;
  }
  if (a2 === 0n) {
    // Unreachable for a genuine ellipse (4AC - B^2 > 0 forces q2 != 0).
    throw new Error('internal error: restriction of an ellipse to a line is not quadratic');
  }
  return { variable, a2, a1, a0, alpha, beta, x0 };
}

/** Sign of a2 t^2 + a1 t + a0 at an exact rational point. */
function quadSign(quad: UnivariateQuadratic, t: Rational): -1 | 0 | 1 {
  const value = Rational.make(quad.a2).mul(t).mul(t)
    .add(Rational.make(quad.a1).mul(t))
    .add(Rational.make(quad.a0));
  return value.sign();
}

/**
 * Computes a rational isolating interval for an exact coordinate root of the
 * quadratic, then tightens it by exact-sign bisection.
 */
export function isolateCoord(
  coord: ExactCoord,
  quad: UnivariateQuadratic,
  iterations = 64,
): RationalInterval {
  if (coord.q === 0n) {
    const v = Rational.make(coord.p, coord.r);
    return { lo: v, hi: v };
  }
  const s = isqrt(coord.radicand); // s < sqrt(radicand) < s + 1 (radicand is not a square)
  let lo: Rational;
  let hi: Rational;
  if (coord.q > 0n) {
    lo = Rational.make(coord.p + coord.q * s, coord.r);
    hi = Rational.make(coord.p + coord.q * (s + 1n), coord.r);
  } else {
    lo = Rational.make(coord.p + coord.q * (s + 1n), coord.r);
    hi = Rational.make(coord.p + coord.q * s, coord.r);
  }
  let signLo = quadSign(quad, lo);
  for (let i = 0; i < iterations; i++) {
    const mid = lo.add(hi).div(2n);
    const signMid = quadSign(quad, mid);
    if (signMid === 0) {
      lo = mid;
      hi = mid;
      break;
    }
    if (signMid === signLo) {
      lo = mid;
      signLo = signMid;
    } else {
      hi = mid;
    }
  }
  return { lo, hi };
}

/** Composes y = alpha * t + beta on an exact coordinate (all BigInt, stays exact). */
function composeLinear(alpha: Rational, beta: Rational, t: ExactCoord): ExactCoord {
  // alpha = an/ad, beta = bn/bd, t = (p + q sqrt(D)) / r
  const an = alpha.num;
  const ad = alpha.den;
  const bn = beta.num;
  const bd = beta.den;
  const p = an * bd * t.p + bn * ad * t.r;
  const q = an * bd * t.q;
  const r = ad * bd * t.r;
  return makeExactCoord(p, q, r, t.radicand);
}

function backSubstitute(
  quad: UnivariateQuadratic,
  tCoord: ExactCoord,
  tInterval: RationalInterval,
): { x: IsolatedCoord; y: IsolatedCoord } {
  if (quad.variable === 'x') {
    const alpha = quad.alpha as Rational;
    const beta = quad.beta as Rational;
    const yCoord = composeLinear(alpha, beta, tCoord);
    const yInterval = ivAdd(ivScale(alpha, tInterval), ivConst(beta));
    return {
      x: { ...tCoord, interval: tInterval },
      y: { ...yCoord, interval: yInterval },
    };
  }
  const x0 = quad.x0 as Rational;
  return {
    x: { ...rationalCoord(x0), interval: makeInterval(x0, x0) },
    y: { ...tCoord, interval: tInterval },
  };
}

/**
 * Intersects a non-degenerate real ellipse with a rational line.
 *
 * The discriminant of the restricted quadratic is computed exactly (BigInt):
 *  - D < 0  -> { kind: 'none' }
 *  - D = 0  -> { kind: 'tangent' } with the exact rational tangency point
 *  - D > 0  -> { kind: 'secant' } with both intersection points, each coordinate
 *              given as (p + q*sqrt(D'))/r plus a rational isolating interval
 *
 * Throws DegenerateConicError / NotAnEllipseError for non-ellipse input.
 */
export function intersectEllipseLine(
  conicInput: ConicInput | Conic,
  lineInput: LineInput | Line,
  options: IntersectOptions = {},
): IntersectionResult {
  const conic = makeConic(conicInput);
  assertEllipse(conic);
  const line = makeLine(lineInput);
  const quad = substituteLine(conic, line);
  const { a2, a1, a0 } = quad;
  const discriminant = a1 * a1 - 4n * a2 * a0;

  if (discriminant < 0n) {
    return { kind: 'none', discriminant, quadratic: quad };
  }

  if (discriminant === 0n) {
    const t = Rational.make(-a1, 2n * a2);
    const { x, y } = backSubstitute(quad, rationalCoord(t), makeInterval(t, t));
    return {
      kind: 'tangent',
      point: { x: Rational.make(x.p, x.r), y: Rational.make(y.p, y.r) },
      quadratic: quad,
    };
  }

  const iterations = options.isolationIterations ?? 64;
  const minus = makeExactCoord(-a1, -1n, 2n * a2, discriminant);
  const plus = makeExactCoord(-a1, 1n, 2n * a2, discriminant);
  const points = [minus, plus].map((coord) => {
    const tInterval = isolateCoord(coord, quad, iterations);
    return backSubstitute(quad, coord, tInterval);
  }) as [SecantPoint, SecantPoint];

  return { kind: 'secant', discriminant, points, quadratic: quad };
}
