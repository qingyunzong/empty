import { Fraction } from "./fraction";
import { Poly, add, normalize, scale } from "./poly";

export interface XY {
  x: Fraction;
  y: Fraction;
}

/** Implicit line a*x + b*y + c = 0 with exact rational coefficients. */
export interface Line {
  a: Fraction;
  b: Fraction;
  c: Fraction;
}

function binom(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  let r = 1n;
  for (let i = 0; i < k; i++) {
    r = (r * BigInt(n - i)) / BigInt(i + 1);
  }
  return r;
}

/**
 * Converts Bernstein (Bezier) control values of degree n to power-basis
 * coefficients: a_j = sum_i b_i * C(n,i) * C(n-i, j-i) * (-1)^(j-i).
 */
export function bernsteinToPower(control: Fraction[]): Poly {
  const n = control.length - 1;
  const coeffs = new Array<Fraction>(n + 1).fill(Fraction.ZERO);
  for (let i = 0; i <= n; i++) {
    const cni = binom(n, i);
    for (let k = 0; k <= n - i; k++) {
      const j = i + k;
      const sign = k % 2 === 0 ? 1n : -1n;
      const term = control[i].mul(Fraction.of(sign * cni * binom(n - i, k)));
      coeffs[j] = coeffs[j].add(term);
    }
  }
  return normalize(coeffs);
}

/** Builds the implicit equation of the line through two distinct points. */
export function lineThrough(p0: XY, p1: XY): Line {
  const a = p0.y.sub(p1.y);
  const b = p1.x.sub(p0.x);
  const c = p0.x.mul(p1.y).sub(p1.x.mul(p0.y));
  if (a.isZero() && b.isZero()) {
    throw new Error("degenerate line: p0 and p1 coincide");
  }
  return { a, b, c };
}

/**
 * Substitutes a Bezier segment (2 to 4 control points, degree <= 3) into
 * the implicit line equation, yielding a univariate polynomial in the
 * segment parameter u. The zero polynomial means the whole segment lies
 * on the line.
 */
export function intersectionPolynomial(points: XY[], line: Line): Poly {
  const xs = bernsteinToPower(points.map((p) => p.x));
  const ys = bernsteinToPower(points.map((p) => p.y));
  let acc = scale(xs, line.a);
  acc = add(acc, scale(ys, line.b));
  acc = add(acc, [line.c]);
  return acc;
}
