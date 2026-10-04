import {
  applyCoupon,
  applyCoupons,
  isLegalSelection,
  validateCoupons,
} from './singleOrder.js';
import type { Coupon, Order } from './types.js';
import { MAX_ORDERS, assertNonNegativeInt } from './types.js';

/** 已结算锁定订单:实付冻结,用券随单锁定。 */
export interface LockedOrder {
  readonly order: Order;
  readonly paymentCents: number;
  /** 该单锁定的券,保持输入序。 */
  readonly coupons: readonly Coupon[];
}

export interface AllocationOptions {
  /** 搜索预算(DFS 节点数);缺省不限。预算耗尽则结果为可行解而非已证最优。 */
  readonly maxNodes?: number;
}

export type AllocationStatus = 'optimal' | 'feasible';

export interface AllocationResult {
  /** optimal: 搜索空间已穷尽,已证最优;feasible: 预算耗尽,当前最优可行解。 */
  readonly status: AllocationStatus;
  /** 全部订单(含锁定)实付合计。 */
  readonly totalPaymentCents: number;
  /** 每券所有权:券 ID -> 订单 ID,未使用为 null。 */
  readonly ownership: Readonly<Record<string, string | null>>;
  /** 逐单金额:订单 ID -> 实付分。 */
  readonly payments: Readonly<Record<string, number>>;
  readonly usedCouponCount: number;
  readonly nodesExplored: number;
}

const UNUSED = -1;
/** 所有权向量中“未使用”的编码,排在任何订单 ID 之后。 */
const UNUSED_KEY = '￿';

interface Candidate {
  assign: number[];
  total: number;
  used: number;
}

/**
 * 多订单券分配:每张券分配给某个可用订单或闲置,目标依次为
 * 总实付最低 -> 用券数最少 -> 所有权向量字典序最小。
 * 分支定界 + 节点预算;锁定订单不参与分配,其实付计入总额且不变。
 */
export function optimizeAllocation(
  orders: readonly Order[],
  coupons: readonly Coupon[],
  locked: readonly LockedOrder[] = [],
  options: AllocationOptions = {},
): AllocationResult {
  if (orders.length + locked.length > MAX_ORDERS) {
    throw new Error(`至多 ${MAX_ORDERS} 个订单,收到 ${orders.length + locked.length} 个`);
  }
  const allCoupons = [...coupons, ...locked.flatMap((l) => l.coupons)];
  validateCoupons(allCoupons);

  const orderIds = new Set<string>();
  for (const order of orders) {
    if (orderIds.has(order.id)) throw new Error(`订单 ID 重复: ${order.id}`);
    orderIds.add(order.id);
    assertNonNegativeInt(order.amountCents, `订单 ${order.id} 金额`);
  }

  let lockedTotal = 0;
  let lockedUsed = 0;
  const lockedOwnership = new Map<string, string>();
  for (const entry of locked) {
    if (orderIds.has(entry.order.id)) throw new Error(`订单 ID 重复: ${entry.order.id}`);
    orderIds.add(entry.order.id);
    if (!isLegalSelection(entry.coupons)) {
      throw new Error(`锁定订单 ${entry.order.id} 的用券组合不合法`);
    }
    const recomputed = applyCoupons(entry.order.amountCents, entry.coupons);
    if (recomputed !== entry.paymentCents) {
      throw new Error(
        `锁定订单 ${entry.order.id} 实付 ${entry.paymentCents} 与用券重算 ${recomputed} 不符`,
      );
    }
    lockedTotal += entry.paymentCents;
    lockedUsed += entry.coupons.length;
    for (const coupon of entry.coupons) lockedOwnership.set(coupon.id, entry.order.id);
  }

  const maxNodes = options.maxNodes ?? Number.POSITIVE_INFINITY;
  const n = coupons.length;
  const m = orders.length;
  const orderIndexOf = new Map(orders.map((o, i) => [o.id, i] as const));

  // 每张券可分配的活跃订单下标;锁定订单不可再分配。
  const allowed: number[][] = coupons.map((coupon) => {
    if (coupon.orders === undefined) return orders.map((_, i) => i);
    const indices: number[] = [];
    for (const orderId of coupon.orders) {
      const index = orderIndexOf.get(orderId);
      if (index === undefined) {
        if (lockedOwnership.size > 0 && locked.some((l) => l.order.id === orderId)) continue;
        throw new Error(`券 ${coupon.id} 引用了未知订单 ${orderId}`);
      }
      indices.push(index);
    }
    return indices;
  });

  const lockedCouponIds = new Set(lockedOwnership.keys());
  // 前置券已被锁定订单占用 -> 本券不可能同单满足前置,禁止使用。
  const forbidden = coupons.map(
    (coupon) => coupon.requires !== undefined && lockedCouponIds.has(coupon.requires),
  );
  const freeIndexOf = new Map(coupons.map((coupon, i) => [coupon.id, i] as const));

  const orderKey = (orderIdx: number): string => (orderIdx === UNUSED ? UNUSED_KEY : orders[orderIdx].id);

  const compareAssign = (a: readonly number[], b: readonly number[]): number => {
    for (let i = 0; i < a.length; i++) {
      const ka = orderKey(a[i]);
      const kb = orderKey(b[i]);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
    }
    return 0;
  };

  const isBetter = (cand: Candidate, incumbent: Candidate): boolean => {
    if (cand.total !== incumbent.total) return cand.total < incumbent.total;
    if (cand.used !== incumbent.used) return cand.used < incumbent.used;
    return compareAssign(cand.assign, incumbent.assign) < 0;
  };

  // 贪心初始解:输入序处理,前置已满足才用,取即时抵扣最大的订单。
  const greedyAssign = ((): number[] => {
    const assign = new Array<number>(n).fill(UNUSED);
    const pay = orders.map((o) => o.amountCents);
    const groups = orders.map(() => new Set<string>());
    for (let i = 0; i < n; i++) {
      const coupon = coupons[i];
      if (forbidden[i]) continue;
      if (coupon.requires !== undefined) {
        const reqIdx = freeIndexOf.get(coupon.requires);
        if (reqIdx === undefined || assign[reqIdx] === UNUSED) continue;
        const o = assign[reqIdx];
        if (coupon.mutexGroup !== undefined && groups[o].has(coupon.mutexGroup)) continue;
        const gain = pay[o] - applyCoupon(pay[o], coupon);
        if (gain > 0) {
          assign[i] = o;
          pay[o] -= gain;
          if (coupon.mutexGroup !== undefined) groups[o].add(coupon.mutexGroup);
        }
        continue;
      }
      let bestOrder = UNUSED;
      let bestGain = 0;
      for (const o of allowed[i]) {
        if (coupon.mutexGroup !== undefined && groups[o].has(coupon.mutexGroup)) continue;
        const gain = pay[o] - applyCoupon(pay[o], coupon);
        if (gain > bestGain) {
          bestGain = gain;
          bestOrder = o;
        }
      }
      if (bestOrder !== UNUSED) {
        assign[i] = bestOrder;
        pay[bestOrder] -= bestGain;
        if (coupon.mutexGroup !== undefined) groups[bestOrder].add(coupon.mutexGroup);
      }
    }
    return assign;
  })();

  const evaluateAssign = (assign: readonly number[]): Candidate => {
    const pay = orders.map((o) => o.amountCents);
    let used = 0;
    for (let i = 0; i < n; i++) {
      const o = assign[i];
      if (o === UNUSED) continue;
      used++;
      pay[o] = applyCoupon(pay[o], coupons[i]);
    }
    let total = lockedTotal;
    for (const p of pay) total += p;
    return { assign: [...assign], total, used };
  };

  let best: Candidate = evaluateAssign(greedyAssign);
  let nodes = 0;
  let exhausted = false;

  const pay = orders.map((o) => o.amountCents);
  const groupsUsed = orders.map(() => new Set<string>());
  const assignedTo = new Array<number>(n).fill(UNUSED);
  // 待决前置:被引用的券下标 -> 必须落入的订单下标。
  const pending = new Map<number, number>();
  let usedSoFar = 0;

  const currentTotal = (): number => {
    let total = lockedTotal;
    for (const p of pay) total += p;
    return total;
  };

  // 可采纳下界:忽略全部约束,剩余券各取最大可得抵扣(全局与逐单两种松弛取紧)。
  const lowerBound = (idx: number): number => {
    let sumPay = 0;
    for (const p of pay) sumPay += p;
    let gainSum = 0;
    const gainPerOrder = new Array<number>(m).fill(0);
    for (let j = idx; j < n; j++) {
      if (forbidden[j]) continue;
      let bestGain = 0;
      for (const o of allowed[j]) {
        const gain = pay[o] - applyCoupon(pay[o], coupons[j]);
        if (gain > bestGain) bestGain = gain;
        gainPerOrder[o] += gain;
      }
      gainSum += bestGain;
    }
    const globalLb = sumPay - Math.min(sumPay, gainSum);
    let perOrderLb = 0;
    for (let o = 0; o < m; o++) perOrderLb += Math.max(0, pay[o] - gainPerOrder[o]);
    return lockedTotal + Math.max(globalLb, perOrderLb);
  };

  // 当前前缀与现任最优的所有权向量比较(仅前 idx 位)。
  const prefixCompare = (idx: number): number => {
    for (let i = 0; i < idx; i++) {
      const ka = orderKey(assignedTo[i]);
      const kb = orderKey(best.assign[i]);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
    }
    return 0;
  };

  const dfs = (idx: number): void => {
    if (exhausted) return;
    if (idx === n) {
      const cand: Candidate = { assign: [...assignedTo], total: currentTotal(), used: usedSoFar };
      if (isBetter(cand, best)) best = cand;
      return;
    }
    nodes++;
    if (nodes > maxNodes) {
      exhausted = true;
      return;
    }
    const lb = lowerBound(idx);
    if (lb > best.total) return;
    if (lb === best.total) {
      // 并列时仍需保证“券数少、ID 序小”的精确性,仅在不可能更优时剪枝。
      if (usedSoFar > best.used) return;
      if (usedSoFar === best.used && prefixCompare(idx) >= 0) return;
    }

    const coupon = coupons[idx];
    const forcedOrder = pending.get(idx);
    const tries: number[] = [];
    if (forcedOrder !== undefined) {
      tries.push(forcedOrder);
    } else if (!forbidden[idx]) {
      const ranked = allowed[idx]
        .map((o) => ({ o, gain: pay[o] - applyCoupon(pay[o], coupon) }))
        .sort((a, b) => b.gain - a.gain || a.o - b.o);
      for (const { o } of ranked) tries.push(o);
    }
    tries.push(UNUSED);

    for (const o of tries) {
      if (o === UNUSED) {
        if (forcedOrder !== undefined) continue; // 被前置约束强制使用
        dfs(idx + 1);
        if (exhausted) return;
        continue;
      }
      if (forbidden[idx]) continue;
      if (!allowed[idx].includes(o)) continue;
      if (coupon.mutexGroup !== undefined && groupsUsed[o].has(coupon.mutexGroup)) continue;
      let addedPending = -1;
      if (coupon.requires !== undefined) {
        const reqIdx = freeIndexOf.get(coupon.requires);
        if (reqIdx !== undefined) {
          if (reqIdx < idx && assignedTo[reqIdx] !== o) continue; // 前置已落定,必须同单
          if (reqIdx > idx) {
            const existing = pending.get(reqIdx);
            if (existing !== undefined && existing !== o) continue; // 前置被多方冲突引用
            if (existing === undefined) {
              pending.set(reqIdx, o);
              addedPending = reqIdx;
            }
          }
        }
      }
      assignedTo[idx] = o;
      const oldPay = pay[o];
      pay[o] = applyCoupon(oldPay, coupon);
      usedSoFar++;
      if (coupon.mutexGroup !== undefined) groupsUsed[o].add(coupon.mutexGroup);
      dfs(idx + 1);
      if (coupon.mutexGroup !== undefined) groupsUsed[o].delete(coupon.mutexGroup);
      usedSoFar--;
      pay[o] = oldPay;
      assignedTo[idx] = UNUSED;
      if (addedPending >= 0) pending.delete(addedPending);
      if (exhausted) return;
    }
  };

  dfs(0);

  const ownership: Record<string, string | null> = {};
  for (const [couponId, orderId] of lockedOwnership) ownership[couponId] = orderId;
  for (let i = 0; i < n; i++) {
    ownership[coupons[i].id] = best.assign[i] === UNUSED ? null : orders[best.assign[i]].id;
  }
  const payments: Record<string, number> = {};
  for (const entry of locked) payments[entry.order.id] = entry.paymentCents;
  const finalPay = orders.map((o) => o.amountCents);
  for (let i = 0; i < n; i++) {
    const o = best.assign[i];
    if (o !== UNUSED) finalPay[o] = applyCoupon(finalPay[o], coupons[i]);
  }
  orders.forEach((order, i) => {
    payments[order.id] = finalPay[i];
  });

  return {
    status: exhausted ? 'feasible' : 'optimal',
    totalPaymentCents: lockedTotal + finalPay.reduce((sum, p) => sum + p, 0),
    ownership,
    payments,
    usedCouponCount: lockedUsed + best.used,
    nodesExplored: nodes,
  };
}
