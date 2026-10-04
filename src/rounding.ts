/**
 * Round-half-even (banker's rounding) of the non-negative rational num/den
 * to the nearest integer. Ties go to the even neighbour.
 */
export function roundHalfEven(num: number, den: number): number {
  if (!Number.isInteger(num) || !Number.isInteger(den) || num < 0 || den <= 0) {
    throw new RangeError(`roundHalfEven expects num >= 0 and den > 0, got ${num}/${den}`);
  }
  const q = Math.floor(num / den);
  const twiceRem = 2 * (num - q * den);
  if (twiceRem > den) return q + 1;
  if (twiceRem < den) return q;
  return q % 2 === 0 ? q : q + 1;
}

/** BigInt twin of roundHalfEven, used by the independent exact checker. */
export function roundHalfEvenBig(num: bigint, den: bigint): bigint {
  if (num < 0n || den <= 0n) {
    throw new RangeError(`roundHalfEvenBig expects num >= 0 and den > 0, got ${num}/${den}`);
  }
  const q = num / den;
  const twiceRem = 2n * (num - q * den);
  if (twiceRem > den) return q + 1n;
  if (twiceRem < den) return q;
  return q % 2n === 0n ? q : q + 1n;
}
