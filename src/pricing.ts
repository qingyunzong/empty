import type { CartRules, Coupon, DiscountRule, OrderCost, ShippingRule } from "./types.js";

/** 满减：floor(subtotal / step) * off，封顶 cap。逐单向下取整发生在这里。 */
export function orderDiscount(subtotal: number, rule: DiscountRule): number {
  if (rule.step <= 0 || rule.off <= 0) return 0;
  const times = Math.floor(subtotal / rule.step);
  const raw = times * rule.off;
  return rule.cap === undefined ? raw : Math.min(raw, rule.cap);
}

/** 运费：折后金额达标免运费。 */
export function shippingFee(afterDiscount: number, rule: ShippingRule): number {
  return afterDiscount >= rule.freeAbove ? 0 : rule.fee;
}

/**
 * 计算一个订单（一组商品 + 可选一张券）的费用。
 * 券门槛按商品小计判断；券不可使商品应付为负（向下截断到 0）。
 */
export function orderCost(
  subtotal: number,
  rules: CartRules,
  coupon: Coupon | null,
): OrderCost {
  const discount = orderDiscount(subtotal, rules.discount);
  const afterDiscount = subtotal - discount;
  const couponValue =
    coupon !== null && subtotal >= coupon.minSpend ? coupon.value : 0;
  const goodsPayable = Math.max(0, afterDiscount - couponValue);
  const shipping = shippingFee(afterDiscount, rules.shipping);
  return {
    subtotal,
    discount,
    couponValue,
    shipping,
    payable: goodsPayable + shipping,
  };
}
