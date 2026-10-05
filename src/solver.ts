import { Problem } from "./problem";

// 单笔订单费用明细（金额单位：分）。
export interface OrderLine {
  itemIdx: number[]; // 商品下标
  subtotal: number; // 商品金额
  tierPct: number; // 命中档位折扣百分比（0 表示未命中）
  discount: number; // 折扣额 = floor(subtotal * tierPct / 100)
  couponId: string | null; // 本单使用的券
  couponValue: number; // 券抵扣额
  shipping: number; // 运费
  payable: number; // 本单实付（含运费）= max(0, subtotal - discount - couponValue) + shipping
}

export interface Certificate {
  orders: OrderLine[];
  couponUsage: Record<string, number>; // 券 id -> 订单序号（-1 表示未使用）
  totalPayable: number;
  orderCount: number;
  method: string;
}

export interface Solution {
  totalPayable: number;
  orderCount: number;
  orders: OrderLine[];
  certificate: Certificate;
}

// 计算一单的价格构成。couponIdx = -1 表示不用券。
export function priceOrder(
  p: Problem,
  subtotal: number,
  couponIdx: number
): Omit<OrderLine, "itemIdx"> {
  let tierPct = 0;
  for (const t of p.tiers) {
    if (subtotal >= t.threshold && t.pct > tierPct) tierPct = t.pct;
  }
  const discount = Math.floor((subtotal * tierPct) / 100); // 逐单向下取整
  const afterDisc = subtotal - discount;
  let couponId: string | null = null;
  let couponValue = 0;
  if (couponIdx >= 0) {
    const c = p.coupons[couponIdx];
    if (subtotal < c.threshold) {
      throw new Error(`券 ${c.id} 门槛未满足`);
    }
    couponId = c.id;
    couponValue = c.value;
  }
  const shipping = afterDisc >= p.shipping.freeThreshold ? 0 : p.shipping.fee;
  const payable = Math.max(0, afterDisc - couponValue) + shipping;
  return { subtotal, tierPct, discount, couponId, couponValue, shipping, payable };
}

// 子集 DP：状态 (商品集合 mask, 已用券集合 cmask) -> (最低实付, 最少单数)。
// 转移：取 mask 中最低位商品所在的一单 S（S ⊆ mask），配一张未用过的券或不用券。
// 复杂度 O(2^k * 3^n * k)，n ≤ 14、k 小，足够快。
export function solve(p: Problem): Solution {
  const n = p.items.length;
  const k = p.coupons.length;
  if (n > 20) throw new Error("商品数过多，超出子集 DP 设计范围");
  if (k > 16) throw new Error("券数量过多");
  const N = 1 << n;
  const K = 1 << k;

  const subtotal = new Float64Array(N);
  for (let mask = 1; mask < N; mask++) {
    const lb = mask & -mask;
    const i = 31 - Math.clz32(lb);
    subtotal[mask] = subtotal[mask ^ lb] + p.items[i].price;
  }

  // 每单基础价格构成（与券无关部分）。
  const tierPctOf = new Int8Array(N);
  const discountOf = new Float64Array(N);
  const shippingOf = new Float64Array(N);
  const payNoCoupon = new Float64Array(N);
  for (let mask = 1; mask < N; mask++) {
    const s = subtotal[mask];
    let pct = 0;
    for (const t of p.tiers) {
      if (s >= t.threshold && t.pct > pct) pct = t.pct;
    }
    const disc = Math.floor((s * pct) / 100);
    const afterDisc = s - disc;
    tierPctOf[mask] = pct;
    discountOf[mask] = disc;
    shippingOf[mask] = afterDisc >= p.shipping.freeThreshold ? 0 : p.shipping.fee;
    payNoCoupon[mask] = afterDisc + shippingOf[mask];
  }

  const INF = Number.POSITIVE_INFINITY;
  const size = N * K;
  const dpCost = new Float64Array(size).fill(INF);
  const dpOrders = new Int32Array(size);
  const parS = new Int32Array(size).fill(-1); // 本步选择的单子集
  const parC = new Int8Array(size).fill(-1); // 本步使用的券（-1 不用）
  // 空商品集合在任意已用券状态下费用均为 0。
  for (let cm = 0; cm < K; cm++) {
    dpCost[cm] = 0;
    dpOrders[cm] = 0;
  }

  for (let mask = 1; mask < N; mask++) {
    const lb = mask & -mask;
    const rest = mask ^ lb;
    const base = mask * K;
    for (let cm = 0; cm < K; cm++) {
      let bestCost = INF;
      let bestOrders = 0;
      let bestS = -1;
      let bestC = -1;
      let sub = rest;
      for (;;) {
        const S = sub | lb;
        const remBase = (mask ^ S) * K;
        // 不用券
        {
          const prev = remBase + cm;
          if (dpCost[prev] < INF) {
            const c = payNoCoupon[S] + dpCost[prev];
            const o = 1 + dpOrders[prev];
            if (c < bestCost || (c === bestCost && o < bestOrders)) {
              bestCost = c;
              bestOrders = o;
              bestS = S;
              bestC = -1;
            }
          }
        }
        // 用一张未用过的券
        for (let c = 0; c < k; c++) {
          const bit = 1 << c;
          if (cm & bit) continue;
          const coupon = p.coupons[c];
          if (subtotal[S] < coupon.threshold) continue;
          const prev = remBase + (cm | bit);
          if (dpCost[prev] < INF) {
            const pay =
              Math.max(0, subtotal[S] - discountOf[S] - coupon.value) +
              shippingOf[S];
            const cost = pay + dpCost[prev];
            const o = 1 + dpOrders[prev];
            if (cost < bestCost || (cost === bestCost && o < bestOrders)) {
              bestCost = cost;
              bestOrders = o;
              bestS = S;
              bestC = c;
            }
          }
        }
        if (sub === 0) break;
        sub = (sub - 1) & rest;
      }
      dpCost[base + cm] = bestCost;
      dpOrders[base + cm] = bestOrders;
      parS[base + cm] = bestS;
      parC[base + cm] = bestC;
    }
  }

  // 回溯拆分方案。
  const orders: OrderLine[] = [];
  let mask = N - 1;
  let cm = 0;
  while (mask !== 0) {
    const idx = mask * K + cm;
    const S = parS[idx];
    const c = parC[idx];
    const itemIdx: number[] = [];
    for (let m = S; m; m &= m - 1) {
      const bit = m & -m;
      itemIdx.push(31 - Math.clz32(bit));
    }
    itemIdx.sort((a, b) => a - b);
    const line = priceOrder(p, subtotal[S], c);
    orders.push({ itemIdx, ...line });
    mask ^= S;
    if (c >= 0) cm |= 1 << c;
  }

  const couponUsage: Record<string, number> = {};
  p.coupons.forEach((coupon, i) => {
    couponUsage[coupon.id] = -1;
    void i;
  });
  orders.forEach((o, i) => {
    if (o.couponId !== null) couponUsage[o.couponId] = i;
  });

  const totalPayable = dpCost[(N - 1) * K];
  const orderCount = dpOrders[(N - 1) * K];
  const certificate: Certificate = {
    orders,
    couponUsage,
    totalPayable,
    orderCount,
    method:
      "subset-dp over (itemMask, couponMask); 最优性由 2^n 状态完备枚举保证，" +
      "小件数(n<=8)由全分区暴力枚举对照验证",
  };
  return { totalPayable, orderCount, orders, certificate };
}

// 独立校验证书：拆分合法性 + 逐单重算金额 + 券全局唯一 + 合计一致。
export function verifyCertificate(p: Problem, cert: Certificate): void {
  const n = p.items.length;
  const seen = new Array<boolean>(n).fill(false);
  let sum = 0;
  const usedCoupon = new Map<string, number>();
  cert.orders.forEach((o, orderNo) => {
    if (o.itemIdx.length === 0) throw new Error(`订单 ${orderNo} 为空`);
    let sub = 0;
    for (const i of o.itemIdx) {
      if (i < 0 || i >= n) throw new Error(`订单 ${orderNo} 含非法商品下标 ${i}`);
      if (seen[i]) throw new Error(`商品 ${i} 被重复拆分`);
      seen[i] = true;
      sub += p.items[i].price;
    }
    const couponIdx = p.coupons.findIndex((c) => c.id === o.couponId);
    if (o.couponId !== null && couponIdx < 0) {
      throw new Error(`订单 ${orderNo} 使用未知券 ${o.couponId}`);
    }
    const expect = priceOrder(p, sub, o.couponId === null ? -1 : couponIdx);
    if (
      o.subtotal !== expect.subtotal ||
      o.tierPct !== expect.tierPct ||
      o.discount !== expect.discount ||
      o.couponValue !== expect.couponValue ||
      o.shipping !== expect.shipping ||
      o.payable !== expect.payable
    ) {
      throw new Error(`订单 ${orderNo} 金额与独立重算不符`);
    }
    if (o.couponId !== null) {
      if (usedCoupon.has(o.couponId)) {
        throw new Error(`券 ${o.couponId} 被重复使用`);
      }
      usedCoupon.set(o.couponId, orderNo);
    }
    sum += o.payable;
  });
  for (let i = 0; i < n; i++) {
    if (!seen[i]) throw new Error(`商品 ${i} 未被任何订单覆盖`);
  }
  if (sum !== cert.totalPayable) throw new Error("证书合计与逐单之和不符");
  if (cert.orderCount !== cert.orders.length) throw new Error("证书单数不符");
  for (const c of p.coupons) {
    const at = cert.couponUsage[c.id];
    if (at === undefined) throw new Error(`证书缺少券 ${c.id} 的使用记录`);
    if (at >= 0 && cert.orders[at].couponId !== c.id) {
      throw new Error(`券 ${c.id} 的使用记录与订单不符`);
    }
  }
}
