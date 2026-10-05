import { orderCost } from "./pricing.js";
import type {
  CartRules,
  Coupon,
  CouponCertificate,
  Item,
  OrderPlan,
  Solution,
} from "./types.js";

export const MAX_ITEMS = 14;
export const MAX_STATE_BITS = 22; // 2^(n+c) 状态数上限，防止内存爆炸

/**
 * 子集动态规划：dp[itemMask][couponMask] = (实付, 订单数) 字典序最小。
 * 转移：取出 mask 最低位商品，枚举包含它的子集 S 作为一个订单，
 *       并选择一张未使用的券（或不用券）。
 * 目标：实付最低；实付并列时订单数最少。
 */
export function solveCart(
  items: Item[],
  rules: CartRules,
  coupons: Coupon[],
): Solution {
  const n = items.length;
  const c = coupons.length;
  if (n < 1) throw new Error("购物车为空");
  if (n > MAX_ITEMS) throw new Error(`商品数超过上限 ${MAX_ITEMS}`);
  if (n + c > MAX_STATE_BITS)
    throw new Error(`状态规模 2^(${n}+${c}) 超过上限 2^${MAX_STATE_BITS}`);

  const itemCount = 1 << n;
  const couponCount = 1 << c;

  // 每个子集的商品小计
  const subtotal = new Float64Array(itemCount);
  for (let mask = 1; mask < itemCount; mask++) {
    const low = mask & -mask;
    const idx = 31 - Math.clz32(low);
    subtotal[mask] = subtotal[mask ^ low] + items[idx].price;
  }

  // cost[mask][j]：j=0 不用券，j>=1 用第 j-1 张券
  const width = c + 1;
  const cost = new Float64Array(itemCount * width);
  for (let mask = 1; mask < itemCount; mask++) {
    const base = mask * width;
    cost[base] = orderCost(subtotal[mask], rules, null).payable;
    for (let j = 1; j <= c; j++) {
      cost[base + j] = orderCost(subtotal[mask], rules, coupons[j - 1]).payable;
    }
  }

  const states = itemCount * couponCount;
  const dpPay = new Float64Array(states).fill(Infinity);
  const dpOrders = new Int32Array(states).fill(0x7fffffff);
  const pickSet = new Int32Array(states); // 选择的订单子集
  const pickCoupon = new Int8Array(states).fill(-1); // -1 不用券
  // mask=0 的所有券状态均为 0：允许券剩余未用（券无使用义务）
  for (let cm = 0; cm < couponCount; cm++) {
    dpPay[cm] = 0;
    dpOrders[cm] = 0;
  }

  for (let mask = 1; mask < itemCount; mask++) {
    const low = mask & -mask;
    for (let cm = 0; cm < couponCount; cm++) {
      let bestPay = Infinity;
      let bestOrders = 0x7fffffff;
      let bestSet = 0;
      let bestCoupon = -1;
      // 枚举包含最低位的子集 S 作为一个订单，避免重复划分
      for (let s = mask; s > 0; s = (s - 1) & mask) {
        if ((s & low) === 0) continue;
        const rest = mask ^ s;
        const restBase = rest * couponCount;
        const costBase = s * width;
        // 不用券
        {
          const pay = cost[costBase] + dpPay[restBase + cm];
          const orders = 1 + dpOrders[restBase + cm];
          if (pay < bestPay || (pay === bestPay && orders < bestOrders)) {
            bestPay = pay;
            bestOrders = orders;
            bestSet = s;
            bestCoupon = -1;
          }
        }
        // 用一张券
        for (let j = 0; j < c; j++) {
          const bit = 1 << j;
          if ((cm & bit) === 0) continue;
          const prev = restBase + (cm ^ bit);
          const pay = cost[costBase + 1 + j] + dpPay[prev];
          const orders = 1 + dpOrders[prev];
          if (pay < bestPay || (pay === bestPay && orders < bestOrders)) {
            bestPay = pay;
            bestOrders = orders;
            bestSet = s;
            bestCoupon = j;
          }
        }
      }
      const state = mask * couponCount + cm;
      dpPay[state] = bestPay;
      dpOrders[state] = bestOrders;
      pickSet[state] = bestSet;
      pickCoupon[state] = bestCoupon;
    }
  }

  // 回溯拆分方案
  const full = itemCount - 1;
  const allCoupons = couponCount - 1;
  const orders: OrderPlan[] = [];
  const usedCoupon = new Array<boolean>(c).fill(false);
  let mask = full;
  let cm = allCoupons;
  while (mask !== 0) {
    const state = mask * couponCount + cm;
    const s = pickSet[state];
    const j = pickCoupon[state];
    const itemIds: string[] = [];
    for (let m = s; m > 0; m &= m - 1) {
      const lowBit = m & -m;
      itemIds.push(items[31 - Math.clz32(lowBit)].id);
    }
    const coupon = j >= 0 ? coupons[j] : null;
    const detail = orderCost(subtotal[s], rules, coupon);
    orders.push({ ...detail, itemIds, couponId: coupon ? coupon.id : null });
    if (j >= 0) {
      usedCoupon[j] = true;
      cm ^= 1 << j;
    }
    mask ^= s;
  }

  const certificate: CouponCertificate = {
    entries: coupons.map((cp, j) => {
      const orderIndex = orders.findIndex((o) => o.couponId === cp.id);
      return {
        couponId: cp.id,
        usedInOrder: usedCoupon[j] && orderIndex >= 0 ? orderIndex : null,
        minSpend: cp.minSpend,
        orderSubtotal: orderIndex >= 0 ? orders[orderIndex].subtotal : null,
        thresholdMet:
          orderIndex >= 0 ? orders[orderIndex].subtotal >= cp.minSpend : true,
      };
    }),
    eachCouponUsedAtMostOnce:
      new Set(orders.map((o) => o.couponId).filter((x) => x !== null)).size ===
      orders.filter((o) => o.couponId !== null).length,
  };

  return {
    totalPay: dpPay[full * couponCount + allCoupons],
    orderCount: dpOrders[full * couponCount + allCoupons],
    orders,
    certificate,
  };
}
