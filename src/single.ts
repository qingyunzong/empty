import { Coupon } from './types';
import { applyCouponList, isLegalSubset } from './apply';

export interface SingleSolution {
  /** lowest achievable payment in cents */
  payment: number;
  /** chosen coupon ids, sorted ascending */
  couponIds: string[];
  legalSubsets: number;
  subsetsEvaluated: number;
}

function lexLess(a: string[], b: string[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * Single-order solver: enumerates every legal subset of the coupon library
 * (at most 2^18), applies each subset in input order, and picks the lowest
 * payment. Ties break on fewer coupons, then on the lexicographically
 * smaller sorted id list.
 */
export function solveSingleOrder(amount: number, coupons: Coupon[]): SingleSolution {
  const n = coupons.length;
  if (n > 18) throw new Error(`at most 18 coupons supported, got ${n}`);
  let bestPayment = -1;
  let bestCount = 0;
  let bestIds: string[] = [];
  let legal = 0;
  const totalSubsets = 1 << n;
  for (let mask = 0; mask < totalSubsets; mask++) {
    const indexes: number[] = [];
    for (let i = 0; i < n; i++) {
      if ((mask >> i) & 1) indexes.push(i);
    }
    if (!isLegalSubset(coupons, indexes)) continue;
    legal++;
    const payment = applyCouponList(amount, indexes.map((i) => coupons[i]));
    const ids = indexes.map((i) => coupons[i].id).sort();
    if (
      bestPayment < 0 ||
      payment < bestPayment ||
      (payment === bestPayment && indexes.length < bestCount) ||
      (payment === bestPayment && indexes.length === bestCount && lexLess(ids, bestIds))
    ) {
      bestPayment = payment;
      bestCount = indexes.length;
      bestIds = ids;
    }
  }
  return {
    payment: bestPayment,
    couponIds: bestIds,
    legalSubsets: legal,
    subsetsEvaluated: totalSubsets,
  };
}
