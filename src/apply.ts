import { Coupon } from './types';

/** Apply one coupon to an integer-cent amount. Percent discounts round down. */
export function applyCoupon(amount: number, coupon: Coupon): number {
  if (coupon.kind === 'amount') {
    return Math.max(0, amount - coupon.value);
  }
  return amount - Math.floor((amount * coupon.value) / 100);
}

/** Apply coupons in input order to an integer-cent amount. */
export function applyCouponList(amount: number, coupons: Coupon[]): number {
  let current = amount;
  for (const coupon of coupons) {
    current = applyCoupon(current, coupon);
  }
  return current;
}

/**
 * Legality of a coupon subset for a single order:
 * every prereq must be inside the subset, and no two coupons may
 * share a mutex group.
 */
export function isLegalSubset(coupons: Coupon[], indexes: number[]): boolean {
  const inSet = new Set(indexes);
  const groups = new Set<string>();
  for (const index of indexes) {
    const coupon = coupons[index];
    if (coupon.prereq !== undefined) {
      const prereqIndex = coupons.findIndex((c) => c.id === coupon.prereq);
      if (prereqIndex < 0 || !inSet.has(prereqIndex)) return false;
    }
    if (coupon.mutexGroup !== undefined) {
      if (groups.has(coupon.mutexGroup)) return false;
      groups.add(coupon.mutexGroup);
    }
  }
  return true;
}
