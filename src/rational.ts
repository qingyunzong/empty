/**
 * Exact rational numbers in [0, 1] used as quantile parameters, so that
 * ceil(p * n) is computed without floating-point error.
 */

export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/**
 * Build a rational num/den. Requires den !== 0; the value must lie in [0, 1]
 * to be usable as a quantile parameter (checked here to fail fast).
 */
export function rational(num: number | bigint, den: number | bigint = 1): Rational {
  const n = BigInt(num);
  const d = BigInt(den);
  if (d === 0n) throw new RangeError("denominator must be non-zero");
  const sign = d < 0n ? -1n : 1n;
  const g = gcd(n, d);
  const rn = (n * sign) / g;
  const rd = (d * sign) / g;
  if (rn < 0n || rn > rd) {
    throw new RangeError(`quantile p must satisfy 0 <= p <= 1, got ${rn}/${rd}`);
  }
  return { num: rn, den: rd };
}

export const ZERO: Rational = { num: 0n, den: 1n };
export const ONE: Rational = { num: 1n, den: 1n };

/**
 * Rank of the p-quantile among n elements: ceil(p * n), with the convention
 * that p = 0 selects the minimum (rank 1). Result is always in [1, n] for
 * n >= 1. Computed exactly with bigints.
 */
export function quantileRank(p: Rational, n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(`n must be a positive safe integer, got ${n}`);
  }
  if (p.num === 0n) return 1;
  const num = p.num * BigInt(n);
  const r = (num + p.den - 1n) / p.den;
  return Number(r);
}
