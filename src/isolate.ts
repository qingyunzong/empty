import { Fraction, isqrt } from "./fraction.js";
import { Interval, ivAdd, ivDiv, ivPoint, ivSub } from "./interval.js";
import { Poly, polyTrim } from "./polynomial.js";

/**
 * Rational bounds lo <= sqrt(value) <= hi with hi - lo <= 2^-precisionBits.
 * Computed with a single exact integer square root.
 */
export function sqrtBounds(value: Fraction, precisionBits: number): Interval {
  if (value.sign() < 0) throw new RangeError("sqrtBounds: negative input");
  const k = BigInt(Math.max(0, Math.floor(precisionBits)));
  const scaled = (value.num << (2n * k)) / value.den;
  const s = isqrt(scaled);
  const scale = 1n << k;
  return { lo: Fraction.fromParts(s, scale), hi: Fraction.fromParts(s + 1n, scale) };
}

function bitLength(b: bigint): number {
  if (b < 0n) b = -b;
  return b === 0n ? 0 : b.toString(2).length;
}

/**
 * Isolating intervals with rational endpoints for every real root of a
 * polynomial of degree <= 2. Each returned interval [lo, hi] satisfies
 * hi - lo <= 2^-precisionBits (point intervals for rational roots).
 */
export function isolateRoots(coeffs: Poly, precisionBits: number): Interval[] {
  const c = polyTrim(coeffs);
  if (c.length < 2) return [];
  if (c.length === 2) {
    const t = c[0].neg().div(c[1]);
    return [ivPoint(t)];
  }
  if (c.length > 3) throw new Error("isolateRoots: degree > 2 not supported");
  const [c0, c1, c2] = c;
  const disc = c1.mul(c1).sub(c0.mul(c2).mul(Fraction.of(4)));
  const sgn = disc.sign();
  if (sgn < 0) return [];
  const twoC2 = c2.mul(Fraction.TWO);
  if (sgn === 0) return [ivPoint(c1.neg().div(twoC2))];
  // Root interval width is (sqrtHi - sqrtLo) / |2*c2|; since |2*c2| >= 1/den(2*c2),
  // refining sqrt by bitLength(den) + 2 extra bits keeps the width <= 2^-precisionBits.
  const extra = bitLength(twoC2.den) + 2;
  const s = sqrtBounds(disc, precisionBits + extra);
  const negC1 = ivPoint(c1.neg());
  const denom = ivPoint(twoC2);
  const roots = [ivDiv(ivSub(negC1, s), denom), ivDiv(ivAdd(negC1, s), denom)];
  roots.sort((a, b) => a.lo.cmp(b.lo));
  return roots;
}
