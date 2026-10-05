/**
 * 并列规则（订单分配序）的编码。
 *
 * 分配向量 a[0..n-1]，a[i] ∈ {0..V-1} 表示订单 i 分给车辆 a[i]，
 * V 表示未分配。把 a 看作 n 位、基 B=V+1 的整数（订单 0 为最高位），
 * 目标值并列时该编码越小越优，即：
 *   按订单编号顺序比较，车辆编号小者优先，“未分配”排在最后。
 */

/** 计算分配向量的并列编码（BigInt）。 */
export function assignmentKey(assignment: number[], vehicleCount: number): bigint {
  const base = BigInt(vehicleCount + 1);
  let key = 0n;
  for (let i = 0; i < assignment.length; i++) {
    const a = assignment[i];
    const digit = a >= 0 && a < vehicleCount ? a : vehicleCount;
    key = key * base + BigInt(digit);
  }
  return key;
}

/** 从并列编码解码出分配向量（与 assignmentKey 互逆）。 */
export function decodeAssignmentKey(
  key: bigint,
  orderCount: number,
  vehicleCount: number,
): number[] {
  const base = BigInt(vehicleCount + 1);
  const digits = new Array<number>(orderCount).fill(vehicleCount);
  let k = key;
  for (let i = orderCount - 1; i >= 0; i--) {
    digits[i] = Number(k % base);
    k /= base;
  }
  return digits.map((d) => (d >= vehicleCount ? -1 : d));
}
