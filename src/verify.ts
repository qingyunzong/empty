import {
  applyCoupons,
  isLegalSelection,
  validateCoupons,
} from './singleOrder.js';
import type { AllocationResult } from './allocator.js';
import type { Coupon, Order } from './types.js';

export const BRUTE_FORCE_MAX_COUPONS = 12;
export const BRUTE_FORCE_MAX_ORDERS = 3;

export interface BruteForceResult {
  readonly totalPaymentCents: number;
  readonly usedCouponCount: number;
  readonly ownership: Record<string, string | null>;
  readonly payments: Record<string, number>;
}

const UNUSED_KEY = '￿';

/**
 * 独立小分配穷举核对:与优化器分离的全空间枚举实现,
 * 仅用于小规模(券 <= 12 且订单 <= 3)下交叉验证优化结果。
 */
export function bruteForceAllocate(
  orders: readonly Order[],
  coupons: readonly Coupon[],
): BruteForceResult {
  validateCoupons(coupons);
  if (coupons.length > BRUTE_FORCE_MAX_COUPONS || orders.length > BRUTE_FORCE_MAX_ORDERS) {
    throw new Error(
      `穷举核对仅支持 <= ${BRUTE_FORCE_MAX_COUPONS} 券且 <= ${BRUTE_FORCE_MAX_ORDERS} 订单`,
    );
  }
  const n = coupons.length;
  const m = orders.length;
  const orderIndexOf = new Map(orders.map((o, i) => [o.id, i] as const));
  const allowed: number[][] = coupons.map((coupon) => {
    if (coupon.orders === undefined) return orders.map((_, i) => i);
    return coupon.orders.map((id) => {
      const index = orderIndexOf.get(id);
      if (index === undefined) throw new Error(`券 ${coupon.id} 引用了未知订单 ${id}`);
      return index;
    });
  });

  const assignment = new Array<number>(n).fill(-1);
  let best: { total: number; used: number; assign: number[] } | null = null;

  const vectorOf = (assign: readonly number[]): string[] =>
    assign.map((o) => (o === -1 ? UNUSED_KEY : orders[o].id));

  const compareVector = (a: readonly string[], b: readonly string[]): number => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  };

  const dfs = (idx: number): void => {
    if (idx === n) {
      const perOrder: Coupon[][] = orders.map(() => []);
      let used = 0;
      for (let i = 0; i < n; i++) {
        if (assignment[i] !== -1) {
          perOrder[assignment[i]].push(coupons[i]);
          used++;
        }
      }
      for (const list of perOrder) {
        if (!isLegalSelection(list)) return;
      }
      let total = 0;
      const payments: number[] = [];
      for (let o = 0; o < m; o++) {
        const payment = applyCoupons(orders[o].amountCents, perOrder[o]);
        payments.push(payment);
        total += payment;
      }
      if (
        best === null ||
        total < best.total ||
        (total === best.total &&
          (used < best.used ||
            (used === best.used && compareVector(vectorOf(assignment), vectorOf(best.assign)) < 0)))
      ) {
        best = { total, used, assign: [...assignment] };
      }
      return;
    }
    for (const o of allowed[idx]) {
      assignment[idx] = o;
      dfs(idx + 1);
    }
    assignment[idx] = -1;
    dfs(idx + 1);
    assignment[idx] = -1;
  };
  dfs(0);

  const final = best as unknown as { total: number; used: number; assign: number[] };
  const ownership: Record<string, string | null> = {};
  const perOrderFinal: Coupon[][] = orders.map(() => []);
  for (let i = 0; i < n; i++) {
    const o = final.assign[i];
    ownership[coupons[i].id] = o === -1 ? null : orders[o].id;
    if (o !== -1) perOrderFinal[o].push(coupons[i]);
  }
  const payments: Record<string, number> = {};
  orders.forEach((order, o) => {
    payments[order.id] = applyCoupons(order.amountCents, perOrderFinal[o]);
  });
  return {
    totalPaymentCents: final.total,
    usedCouponCount: final.used,
    ownership,
    payments,
  };
}

export interface CrossCheckResult {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

/** 用独立穷举结果核对优化器结果(总额、用券数、逐单金额、每券所有权)。 */
export function crossCheckAllocation(
  orders: readonly Order[],
  coupons: readonly Coupon[],
  result: AllocationResult,
): CrossCheckResult {
  const expected = bruteForceAllocate(orders, coupons);
  const mismatches: string[] = [];
  if (result.status !== 'optimal') {
    mismatches.push(`优化器未证明最优(状态 ${result.status}),不参与核对`);
  }
  if (result.totalPaymentCents !== expected.totalPaymentCents) {
    mismatches.push(`总实付不符: 优化 ${result.totalPaymentCents} != 穷举 ${expected.totalPaymentCents}`);
  }
  if (result.usedCouponCount !== expected.usedCouponCount) {
    mismatches.push(`用券数不符: 优化 ${result.usedCouponCount} != 穷举 ${expected.usedCouponCount}`);
  }
  for (const order of orders) {
    if (result.payments[order.id] !== expected.payments[order.id]) {
      mismatches.push(
        `订单 ${order.id} 金额不符: 优化 ${result.payments[order.id]} != 穷举 ${expected.payments[order.id]}`,
      );
    }
  }
  for (const coupon of coupons) {
    if (result.ownership[coupon.id] !== expected.ownership[coupon.id]) {
      mismatches.push(
        `券 ${coupon.id} 所有权不符: 优化 ${result.ownership[coupon.id]} != 穷举 ${expected.ownership[coupon.id]}`,
      );
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
