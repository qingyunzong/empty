import {
  optimizeAllocation,
  type AllocationResult,
  type LockedOrder,
} from './allocator.js';
import { applyCoupons, validateCoupons } from './singleOrder.js';
import type { Coupon, Order } from './types.js';
import { MAX_COUPONS, MAX_ORDERS, assertNonNegativeInt } from './types.js';

export const DEFAULT_NODE_BUDGET = 100_000;

export interface SettledOrderView {
  readonly order: Order;
  readonly paymentCents: number;
  readonly couponIds: readonly string[];
}

export interface LibraryReport {
  readonly status: AllocationResult['status'];
  readonly totalPaymentCents: number;
  /** 每券所有权:券 ID -> 订单 ID,未使用为 null。 */
  readonly ownership: Readonly<Record<string, string | null>>;
  /** 逐单金额:订单 ID -> 实付分(含已结算锁定单)。 */
  readonly payments: Readonly<Record<string, number>>;
  readonly settledOrders: readonly SettledOrderView[];
}

/**
 * 优惠库会话:维护券池与订单,负责分配优化、结算锁定与退款重算。
 * 已结算订单实付冻结;退款撤销该单用券并重新分配未锁订单。
 */
export class CouponLibrary {
  #coupons: Coupon[] = [];
  #orders = new Map<string, Order>();
  #settled = new Map<string, LockedOrder>();
  #last: AllocationResult | null = null;

  addCoupon(coupon: Coupon): void {
    if (this.#coupons.some((c) => c.id === coupon.id)) {
      throw new Error(`券 ID 重复: ${coupon.id}`);
    }
    if (this.#coupons.length >= MAX_COUPONS) {
      throw new Error(`至多 ${MAX_COUPONS} 张券`);
    }
    this.#coupons.push(coupon);
    this.#last = null;
  }

  addOrder(order: Order): void {
    if (this.#orders.has(order.id) || this.#settled.has(order.id)) {
      throw new Error(`订单 ID 重复: ${order.id}`);
    }
    if (this.#orders.size + this.#settled.size >= MAX_ORDERS) {
      throw new Error(`至多 ${MAX_ORDERS} 个订单`);
    }
    assertNonNegativeInt(order.amountCents, `订单 ${order.id} 金额`);
    this.#orders.set(order.id, order);
    this.#last = null;
  }

  /** 对未锁订单与空闲券做最优分配;锁定订单实付不变。 */
  optimize(maxNodes: number = DEFAULT_NODE_BUDGET): AllocationResult {
    const locked = [...this.#settled.values()];
    const lockedCouponIds = new Set(locked.flatMap((l) => l.coupons.map((c) => c.id)));
    const freeCoupons = this.#coupons.filter((c) => !lockedCouponIds.has(c.id));
    validateCoupons(this.#coupons);
    this.#last = optimizeAllocation([...this.#orders.values()], freeCoupons, locked, {
      maxNodes,
    });
    return this.#last;
  }

  /** 结算并锁定订单:冻结当前实付与用券。 */
  settle(orderId: string): SettledOrderView {
    const order = this.#orders.get(orderId);
    if (order === undefined) throw new Error(`订单不存在或已结算: ${orderId}`);
    const last = this.#last ?? this.optimize();
    const payment = last.payments[orderId];
    if (payment === undefined) throw new Error(`订单 ${orderId} 缺少分配结果`);
    const couponIds = this.#coupons
      .filter((c) => last.ownership[c.id] === orderId)
      .map((c) => c.id);
    const coupons = this.#coupons.filter((c) => couponIds.includes(c.id));
    const recomputed = applyCoupons(order.amountCents, coupons);
    if (recomputed !== payment) {
      throw new Error(`订单 ${orderId} 实付校验失败: ${payment} != ${recomputed}`);
    }
    this.#orders.delete(orderId);
    this.#settled.set(orderId, { order, paymentCents: payment, coupons });
    this.#last = null;
    return { order, paymentCents: payment, couponIds };
  }

  /**
   * 退款:撤销该单(活跃或已结算),其券回到券池,
   * 随后重新分配未锁订单;其余锁定单实付不变。
   */
  refund(orderId: string, maxNodes: number = DEFAULT_NODE_BUDGET): AllocationResult {
    if (!this.#orders.delete(orderId) && !this.#settled.delete(orderId)) {
      throw new Error(`订单不存在: ${orderId}`);
    }
    this.#last = null;
    return this.optimize(maxNodes);
  }

  /** 当前每券所有权与逐单金额(必要时先优化)。 */
  report(maxNodes: number = DEFAULT_NODE_BUDGET): LibraryReport {
    const last = this.#last ?? this.optimize(maxNodes);
    return {
      status: last.status,
      totalPaymentCents: last.totalPaymentCents,
      ownership: last.ownership,
      payments: last.payments,
      settledOrders: [...this.#settled.values()].map((l) => ({
        order: l.order,
        paymentCents: l.paymentCents,
        couponIds: l.coupons.map((c) => c.id),
      })),
    };
  }

  /** 重算校验:逐单按所有权重新计算实付,与报告值一致才通过。 */
  verifyPayments(maxNodes: number = DEFAULT_NODE_BUDGET): boolean {
    const report = this.report(maxNodes);
    const byOrder = new Map<string, Coupon[]>();
    for (const coupon of this.#coupons) {
      const owner = report.ownership[coupon.id];
      if (owner === null || owner === undefined) continue;
      const list = byOrder.get(owner) ?? [];
      list.push(coupon);
      byOrder.set(owner, list);
    }
    for (const [orderId, payment] of Object.entries(report.payments)) {
      const order =
        this.#orders.get(orderId) ?? this.#settled.get(orderId)?.order;
      if (order === undefined) return false;
      const coupons = byOrder.get(orderId) ?? [];
      if (applyCoupons(order.amountCents, coupons) !== payment) return false;
    }
    return true;
  }
}
