import type { Coupon } from './types.js';
import { MAX_COUPONS, assertNonNegativeInt } from './types.js';

/** 单张券作用于整数分;amount 触底为 0,percent 向下取整。 */
export function applyCoupon(paymentCents: number, coupon: Coupon): number {
  assertNonNegativeInt(paymentCents, '实付金额');
  if (coupon.kind === 'amount') {
    return Math.max(0, paymentCents - coupon.value);
  }
  return paymentCents - Math.floor((paymentCents * coupon.value) / 100);
}

/** 按输入序依次作用于一单。 */
export function applyCoupons(amountCents: number, coupons: readonly Coupon[]): number {
  let payment = amountCents;
  for (const coupon of coupons) {
    payment = applyCoupon(payment, coupon);
  }
  return payment;
}

/** 校验券库:数量上限、ID 唯一、面值合法、前置存在且无环。 */
export function validateCoupons(coupons: readonly Coupon[]): void {
  if (coupons.length > MAX_COUPONS) {
    throw new Error(`至多 ${MAX_COUPONS} 张券,收到 ${coupons.length} 张`);
  }
  const ids = new Set<string>();
  for (const coupon of coupons) {
    if (ids.has(coupon.id)) throw new Error(`券 ID 重复: ${coupon.id}`);
    ids.add(coupon.id);
    assertNonNegativeInt(coupon.value, `券 ${coupon.id} 面值`);
    if (coupon.kind === 'percent' && coupon.value > 100) {
      throw new Error(`券 ${coupon.id} 百分比须在 0..100,收到 ${coupon.value}`);
    }
  }
  for (const coupon of coupons) {
    if (coupon.requires !== undefined && !ids.has(coupon.requires)) {
      throw new Error(`券 ${coupon.id} 的前置券不存在: ${coupon.requires}`);
    }
  }
  const requiresOf = new Map(coupons.map((c) => [c.id, c.requires] as const));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): void => {
    const seen = state.get(id);
    if (seen === 1) throw new Error(`前置关系存在环,涉及券: ${id}`);
    if (seen === 2) return;
    state.set(id, 1);
    const required = requiresOf.get(id);
    if (required !== undefined) visit(required);
    state.set(id, 2);
  };
  for (const coupon of coupons) visit(coupon.id);
}

/** 子集合法性:有向前置齐备、互斥组不叠加(used 保持输入序)。 */
export function isLegalSelection(used: readonly Coupon[]): boolean {
  const ids = new Set(used.map((c) => c.id));
  const groups = new Set<string>();
  for (const coupon of used) {
    if (coupon.requires !== undefined && !ids.has(coupon.requires)) return false;
    if (coupon.mutexGroup !== undefined) {
      if (groups.has(coupon.mutexGroup)) return false;
      groups.add(coupon.mutexGroup);
    }
  }
  return true;
}

/** ID 序比较:排序后的 ID 序列按字典序。 */
export function compareIdSequences(a: readonly string[], b: readonly string[]): number {
  const sa = [...a].sort();
  const sb = [...b].sort();
  const len = Math.min(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    if (sa[i] < sb[i]) return -1;
    if (sa[i] > sb[i]) return 1;
  }
  return sa.length - sb.length;
}

export interface SingleOrderOptimum {
  readonly paymentCents: number;
  /** 选中的券 ID,按输入序。 */
  readonly usedCouponIds: readonly string[];
  readonly legalSubsets: number;
  readonly totalSubsets: number;
}

/**
 * 单订单最优用券:枚举全部 2^n 子集中的合法子集,
 * 依次按 实付最低 -> 券数最少 -> ID 序最小 选取。
 */
export function optimizeSingleOrder(
  amountCents: number,
  coupons: readonly Coupon[],
): SingleOrderOptimum {
  validateCoupons(coupons);
  assertNonNegativeInt(amountCents, '订单金额');
  const n = coupons.length;
  const totalSubsets = 1 << n;
  let bestPayment = amountCents;
  let bestUsed: string[] = [];
  let legalSubsets = 0;
  for (let mask = 0; mask < totalSubsets; mask++) {
    const used: Coupon[] = [];
    for (let i = 0; i < n; i++) {
      if ((mask & (1 << i)) !== 0) used.push(coupons[i]);
    }
    if (!isLegalSelection(used)) continue;
    legalSubsets++;
    const payment = applyCoupons(amountCents, used);
    const ids = used.map((c) => c.id);
    if (
      payment < bestPayment ||
      (payment === bestPayment &&
        (ids.length < bestUsed.length ||
          (ids.length === bestUsed.length && compareIdSequences(ids, bestUsed) < 0)))
    ) {
      bestPayment = payment;
      bestUsed = ids;
    }
  }
  return { paymentCents: bestPayment, usedCouponIds: bestUsed, legalSubsets, totalSubsets };
}

/** 枚举全部合法子集,验证所报金额是否等于最优实付。 */
export function verifySingleOrderPayment(
  amountCents: number,
  coupons: readonly Coupon[],
  claimedPaymentCents: number,
): boolean {
  return optimizeSingleOrder(amountCents, coupons).paymentCents === claimedPaymentCents;
}
