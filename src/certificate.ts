import { orderCost } from "./pricing.js";
import type { CartRules, Coupon, Item, Solution } from "./types.js";

/**
 * 独立核验一份拆分方案与券证书。
 * 返回违规列表；空数组表示方案合法（不保证最优，最优性由求解器/对照保证）。
 */
export function verifySolution(
  items: Item[],
  rules: CartRules,
  coupons: Coupon[],
  solution: Solution,
): string[] {
  const violations: string[] = [];
  const priceById = new Map(items.map((it) => [it.id, it.price]));
  const couponById = new Map(coupons.map((cp) => [cp.id, cp]));

  // 1. 拆分必须是集合划分：每件商品恰好出现一次
  const seen = new Set<string>();
  for (const order of solution.orders) {
    for (const id of order.itemIds) {
      if (!priceById.has(id)) violations.push(`未知商品 ${id}`);
      if (seen.has(id)) violations.push(`商品 ${id} 被重复分配`);
      seen.add(id);
    }
  }
  for (const it of items) {
    if (!seen.has(it.id)) violations.push(`商品 ${it.id} 未被分配`);
  }

  // 2. 逐单重算费用明细
  let total = 0;
  solution.orders.forEach((order, idx) => {
    const subtotal = order.itemIds.reduce(
      (sum, id) => sum + (priceById.get(id) ?? 0),
      0,
    );
    const coupon =
      order.couponId !== null
        ? (couponById.get(order.couponId) ?? null)
        : null;
    if (order.couponId !== null && coupon === null) {
      violations.push(`订单 ${idx} 使用未知券 ${order.couponId}`);
    }
    const expected = orderCost(subtotal, rules, coupon);
    if (order.subtotal !== expected.subtotal)
      violations.push(`订单 ${idx} 小计不符: ${order.subtotal} != ${expected.subtotal}`);
    if (order.discount !== expected.discount)
      violations.push(`订单 ${idx} 满减不符: ${order.discount} != ${expected.discount}`);
    if (order.couponValue !== expected.couponValue)
      violations.push(`订单 ${idx} 券抵扣不符: ${order.couponValue} != ${expected.couponValue}`);
    if (order.shipping !== expected.shipping)
      violations.push(`订单 ${idx} 运费不符: ${order.shipping} != ${expected.shipping}`);
    if (order.payable !== expected.payable)
      violations.push(`订单 ${idx} 实付不符: ${order.payable} != ${expected.payable}`);
    total += order.payable;
  });
  if (total !== solution.totalPay)
    violations.push(`总实付不符: ${solution.totalPay} != ${total}`);
  if (solution.orderCount !== solution.orders.length)
    violations.push(`订单数不符: ${solution.orderCount} != ${solution.orders.length}`);

  // 3. 券证书核验：每张券全局限用一次、门槛满足、证书与方案一致
  const usageCount = new Map<string, number>();
  for (const order of solution.orders) {
    if (order.couponId !== null) {
      usageCount.set(order.couponId, (usageCount.get(order.couponId) ?? 0) + 1);
    }
  }
  for (const [id, count] of usageCount) {
    if (count > 1) violations.push(`券 ${id} 被使用 ${count} 次（全局限一次）`);
  }
  const cert = solution.certificate;
  if (cert.entries.length !== coupons.length)
    violations.push(`证书记录数 ${cert.entries.length} 与券数 ${coupons.length} 不符`);
  for (const entry of cert.entries) {
    const count = usageCount.get(entry.couponId) ?? 0;
    if (entry.usedInOrder === null && count > 0)
      violations.push(`证书称券 ${entry.couponId} 未使用，但方案中使用了`);
    if (entry.usedInOrder !== null) {
      const order = solution.orders[entry.usedInOrder];
      if (!order || order.couponId !== entry.couponId)
        violations.push(`证书中券 ${entry.couponId} 的订单指向与方案不符`);
      else if (!entry.thresholdMet)
        violations.push(`券 ${entry.couponId} 门槛未满足却被使用`);
    }
  }
  const actualOnce = [...usageCount.values()].every((cnt) => cnt <= 1);
  if (cert.eachCouponUsedAtMostOnce !== actualOnce)
    violations.push("证书的 eachCouponUsedAtMostOnce 标记与事实不符");

  return violations;
}
