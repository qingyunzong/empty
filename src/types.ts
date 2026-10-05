/** 金额单位：分（整数），避免浮点误差。 */

export interface Item {
  id: string;
  name: string;
  price: number; // 单价（分）
}

/** 满减规则：每满 step 减 off，单笔订单封顶 cap（缺省不封顶）。逐单向下取整。 */
export interface DiscountRule {
  step: number;
  off: number;
  cap?: number;
}

/** 运费规则：折后金额 >= freeAbove 免运费，否则收 fee。 */
export interface ShippingRule {
  fee: number;
  freeAbove: number;
}

/** 优惠券：小计满 minSpend 可用，抵 value。每张券全局限用一次，每单限用一张。 */
export interface Coupon {
  id: string;
  minSpend: number;
  value: number;
}

export interface CartRules {
  discount: DiscountRule;
  shipping: ShippingRule;
}

/** 单个订单的费用明细。 */
export interface OrderCost {
  subtotal: number;     // 商品小计
  discount: number;     // 满减（逐单向下取整）
  couponValue: number;  // 券抵扣（0 表示未用券）
  shipping: number;     // 运费
  payable: number;      // 本单实付 = max(0, 小计-满减-券) + 运费
}

/** 一个订单的拆分结果。 */
export interface OrderPlan extends OrderCost {
  itemIds: string[];
  couponId: string | null;
}

/** 券证书：记录每张券的去向，供独立核验。 */
export interface CouponCertificateEntry {
  couponId: string;
  usedInOrder: number | null; // 订单序号；null 表示未使用
  minSpend: number;
  orderSubtotal: number | null;
  thresholdMet: boolean;      // 若使用，门槛是否满足
}

export interface CouponCertificate {
  entries: CouponCertificateEntry[];
  eachCouponUsedAtMostOnce: boolean;
}

export interface Solution {
  totalPay: number;
  orderCount: number;
  orders: OrderPlan[];
  certificate: CouponCertificate;
}
