/**
 * Quantile rank rule.
 *
 * p is a rational number pNum/pDen with 0 <= p <= 1. For a window of n
 * elements the quantile is the element at rank ceil(p * n) in sorted order
 * (1-based). p = 0 yields rank 0 by the formula, which is clamped to rank 1,
 * i.e. the minimum. BigInt arithmetic keeps the ceiling exact for any
 * integer numerator/denominator.
 */
export function quantileRank(pNum: number, pDen: number, n: number): number {
  if (!Number.isSafeInteger(pNum) || !Number.isSafeInteger(pDen) || pDen <= 0) {
    throw new RangeError(`p must be a rational with positive integer denominator, got ${pNum}/${pDen}`);
  }
  if (pNum < 0 || pNum > pDen) {
    throw new RangeError(`p must satisfy 0 <= p <= 1, got ${pNum}/${pDen}`);
  }
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new RangeError(`n must be a positive integer, got ${n}`);
  }
  const num = BigInt(pNum) * BigInt(n);
  const den = BigInt(pDen);
  const rank = Number((num + den - 1n) / den); // exact ceiling division
  return rank < 1 ? 1 : rank;
}
