export const MAX_COUPONS = 18;
export const MAX_ORDERS = 8;

export type CouponKind = 'amount' | 'percent';

export interface Coupon {
  /** 券 ID,全局唯一,字符串序即“ID 序”。 */
  readonly id: string;
  /** amount: 定额减 value 分;percent: 减免 value%(0..100),向下取整。 */
  readonly kind: CouponKind;
  readonly value: number;
  /** 有向前置:使用本券前必须在同一订单上使用 id 为 requires 的券。 */
  readonly requires?: string;
  /** 互斥组:同一订单上同组券不可叠加。 */
  readonly mutexGroup?: string;
  /** 可用订单 ID 列表;缺省表示跨订单共享(全部订单可用)。 */
  readonly orders?: readonly string[];
}

export interface Order {
  readonly id: string;
  /** 订单金额,整数分。 */
  readonly amountCents: number;
}

export function assertNonNegativeInt(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${what} 必须是非负整数(分),收到 ${value}`);
  }
}
