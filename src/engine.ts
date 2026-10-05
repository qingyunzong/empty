import { Coupon, OrderSpec, SolveResult } from './types';
import { solveSingleOrder } from './single';
import { solveMultiOrder } from './solver';

export const DEFAULT_NODE_BUDGET = 2_000_000;
export const MAX_COUPONS = 18;
export const MAX_ORDERS = 8;

/**
 * Stateful facade over the solvers. Holds the coupon library and the orders,
 * supports settling (locking) orders and refunding (revoking) coupons with
 * recomputation. Settled orders keep their locked payment across re-solves.
 */
export class CouponEngine {
  private coupons: Coupon[] = [];
  private orders: OrderSpec[] = [];
  private last: SolveResult | null = null;

  addCoupon(coupon: Coupon): void {
    if (this.coupons.length >= MAX_COUPONS) {
      throw new Error(`at most ${MAX_COUPONS} coupons`);
    }
    if (this.coupons.some((c) => c.id === coupon.id)) {
      throw new Error(`duplicate coupon id ${coupon.id}`);
    }
    if (coupon.prereq !== undefined && coupon.prereq === coupon.id) {
      throw new Error('a coupon cannot be its own prereq');
    }
    if (coupon.kind === 'percent') {
      if (!Number.isInteger(coupon.value) || coupon.value < 0 || coupon.value > 100) {
        throw new Error('percent value must be an integer in 0..100');
      }
    } else if (!Number.isInteger(coupon.value) || coupon.value < 0) {
      throw new Error('amount value must be a non-negative integer (cents)');
    }
    this.coupons.push({ ...coupon });
    this.last = null;
  }

  addOrder(id: string, amount: number): void {
    if (this.orders.length >= MAX_ORDERS) {
      throw new Error(`at most ${MAX_ORDERS} orders`);
    }
    if (this.orders.some((o) => o.id === id)) {
      throw new Error(`duplicate order id ${id}`);
    }
    if (!Number.isInteger(amount) || amount < 0) {
      throw new Error('order amount must be a non-negative integer (cents)');
    }
    this.orders.push({ id, amount });
    this.last = null;
  }

  /**
   * Solve the current assignment problem. A single unsettled order is solved
   * by exhaustive subset enumeration; anything else uses the budgeted
   * multi-order search.
   */
  solve(maxNodes: number = DEFAULT_NODE_BUDGET): SolveResult {
    if (this.orders.length === 0) throw new Error('no orders');
    const anySettled = this.orders.some((o) => o.settled);
    let result: SolveResult;
    if (this.orders.length === 1 && !anySettled) {
      const order = this.orders[0];
      const s = solveSingleOrder(order.amount, this.coupons);
      const ownership: Record<string, string[]> = {};
      for (const c of this.coupons) {
        ownership[c.id] = s.couponIds.includes(c.id) ? [order.id] : [];
      }
      result = {
        status: 'optimal',
        provenOptimal: true,
        total: s.payment,
        ownership,
        orderAmounts: { [order.id]: s.payment },
        nodesExplored: s.subsetsEvaluated,
        budgetExhausted: false,
      };
    } else {
      result = solveMultiOrder(this.coupons, this.orders, maxNodes);
    }
    this.last = result;
    return result;
  }

  /** Lock an order's payment at its value from the last successful solve. */
  settle(orderId: string): void {
    if (this.last === null || this.last.status === 'infeasible') {
      throw new Error('a successful solve is required before settle');
    }
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);
    order.settled = true;
    order.lockedAmount = this.last.orderAmounts[orderId];
  }

  /**
   * Revoke coupons (refund) and re-solve. Remaining coupons are reassigned
   * among all orders, but settled orders must keep their locked payment;
   * if that is impossible the result status is 'infeasible'.
   */
  refund(couponIds: string[], maxNodes: number = DEFAULT_NODE_BUDGET): SolveResult {
    for (const id of couponIds) {
      const index = this.coupons.findIndex((c) => c.id === id);
      if (index < 0) throw new Error(`unknown coupon ${id}`);
      this.coupons.splice(index, 1);
    }
    return this.solve(maxNodes);
  }

  getCoupons(): readonly Coupon[] {
    return this.coupons;
  }

  getOrders(): readonly OrderSpec[] {
    return this.orders;
  }
}
