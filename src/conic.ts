import { Rational, RationalInput } from './rational.js';
import {
  RationalInterval,
  ivAdd,
  ivConst,
  ivScale,
  ivSquare,
  ivMul,
} from './interval.js';

/**
 * General conic  Q(x, y) = A x^2 + B x y + C y^2 + D x + E y + F = 0
 * with exact rational coefficients.
 */
export interface Conic {
  readonly A: Rational;
  readonly B: Rational;
  readonly C: Rational;
  readonly D: Rational;
  readonly E: Rational;
  readonly F: Rational;
}

export type ConicInput = {
  readonly [K in 'A' | 'B' | 'C' | 'D' | 'E' | 'F']: RationalInput;
};

export function makeConic(input: ConicInput | Conic): Conic {
  return {
    A: Rational.from(input.A),
    B: Rational.from(input.B),
    C: Rational.from(input.C),
    D: Rational.from(input.D),
    E: Rational.from(input.E),
    F: Rational.from(input.F),
  };
}

export class ConicError extends Error {
  override readonly name: string = 'ConicError';
}

/** The conic is degenerate (det of the 3x3 matrix is zero): point, line pair, etc. */
export class DegenerateConicError extends ConicError {
  override readonly name: string = 'DegenerateConicError';
}

/** The conic is not a real ellipse (hyperbola, parabola, imaginary ellipse, ...). */
export class NotAnEllipseError extends ConicError {
  override readonly name: string = 'NotAnEllipseError';
}

export interface ConicInvariants {
  /** delta = 4AC - B^2 (negative of the usual B^2 - 4AC). */
  readonly delta: Rational;
  /** bigDelta = det of the 3x3 conic matrix. */
  readonly bigDelta: Rational;
}

export function conicInvariants(c: Conic): ConicInvariants {
  const delta = c.A.mul(c.C).mul(4n).sub(c.B.mul(c.B));
  const b2 = c.B.div(2n);
  const d2 = c.D.div(2n);
  const e2 = c.E.div(2n);
  // det [[A, B/2, D/2], [B/2, C, E/2], [D/2, E/2, F]]
  const bigDelta = c.A.mul(c.C).mul(c.F)
    .add(b2.mul(e2).mul(d2))
    .add(d2.mul(b2).mul(e2))
    .sub(d2.mul(c.C).mul(d2))
    .sub(b2.mul(b2).mul(c.F))
    .sub(c.A.mul(e2).mul(e2));
  return { delta, bigDelta };
}

/**
 * Accepts only non-degenerate real ellipses; throws otherwise.
 *  - delta <= 0            -> parabola/hyperbola (or degenerate with parallel lines)
 *  - bigDelta === 0        -> degenerate conic
 *  - bigDelta * (A+C) > 0  -> imaginary ellipse (empty real locus)
 */
export function assertEllipse(c: Conic): ConicInvariants {
  const inv = conicInvariants(c);
  if (inv.delta.sign() <= 0) {
    throw new NotAnEllipseError(`not an ellipse: 4AC - B^2 = ${inv.delta} (must be > 0)`);
  }
  if (inv.bigDelta.sign() === 0) {
    throw new DegenerateConicError('degenerate conic: determinant of the conic matrix is 0');
  }
  if (inv.bigDelta.mul(c.A.add(c.C)).sign() >= 0) {
    throw new NotAnEllipseError('imaginary ellipse: the real locus is empty');
  }
  return inv;
}

/** Exact evaluation Q(x, y) at a rational point. */
export function evalConic(c: Conic, x: Rational, y: Rational): Rational {
  return c.A.mul(x).mul(x)
    .add(c.B.mul(x).mul(y))
    .add(c.C.mul(y).mul(y))
    .add(c.D.mul(x))
    .add(c.E.mul(y))
    .add(c.F);
}

/** Interval enclosure of Q over an axis-aligned box (used for back-substitution checks). */
export function evalConicInterval(c: Conic, x: RationalInterval, y: RationalInterval): RationalInterval {
  const terms: RationalInterval[] = [
    ivScale(c.A, ivSquare(x)),
    ivScale(c.B, ivMul(x, y)),
    ivScale(c.C, ivSquare(y)),
    ivScale(c.D, x),
    ivScale(c.E, y),
    ivConst(c.F),
  ];
  return terms.reduce(ivAdd);
}
