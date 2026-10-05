import { Problem } from "./problem";
import { priceOrder } from "./solver";

export interface BruteResult {
  totalPayable: number;
  orderCount: number;
  partitionsChecked: number;
}

// 暴力对照：用受限增长串（RGS）枚举全部集合分区，
// 每个分区内部再用小 DP 解决"订单×券"的最优指派（每张券至多一次）。
// 仅用于小件数（n ≤ 10 左右）验证子集 DP 的正确性。
export function bruteForce(p: Problem): BruteResult {
  const n = p.items.length;
  const k = p.coupons.length;
  const K = 1 << k;
  const assign = new Int32Array(n);
  let bestCost = Number.POSITIVE_INFINITY;
  let bestOrders = 0;
  let partitionsChecked = 0;

  // 单分区评估：blocks 个子集的商品金额，求最优券指派下的 (实付, 单数)。
  function evaluate(blockSums: Float64Array, blocks: number): void {
    partitionsChecked++;
    // g[bi][cm]：前 bi 个块、已用券集合 cm 的最低费用。
    const INF = Number.POSITIVE_INFINITY;
    let prev = new Float64Array(K).fill(INF);
    prev[0] = 0;
    for (let bi = 0; bi < blocks; bi++) {
      const next = new Float64Array(K).fill(INF);
      const s = blockSums[bi];
      const noCoupon = priceOrder(p, s, -1).payable;
      for (let cm = 0; cm < K; cm++) {
        if (prev[cm] === INF) continue;
        // 本块不用券
        if (prev[cm] + noCoupon < next[cm]) next[cm] = prev[cm] + noCoupon;
        // 本块用一张未用过的券
        for (let c = 0; c < k; c++) {
          const bit = 1 << c;
          if (cm & bit) continue;
          if (s < p.coupons[c].threshold) continue;
          const pay = priceOrder(p, s, c).payable;
          const nm = cm | bit;
          if (prev[cm] + pay < next[nm]) next[nm] = prev[cm] + pay;
        }
      }
      prev = next;
    }
    let cost = INF;
    for (let cm = 0; cm < K; cm++) {
      if (prev[cm] < cost) cost = prev[cm];
    }
    if (cost < bestCost || (cost === bestCost && blocks < bestOrders)) {
      bestCost = cost;
      bestOrders = blocks;
    }
  }

  const blockSums = new Float64Array(n);
  function rec(i: number, blocks: number): void {
    if (i === n) {
      evaluate(blockSums, blocks);
      return;
    }
    const price = p.items[i].price;
    for (let b = 0; b <= blocks; b++) {
      assign[i] = b;
      blockSums[b] += price;
      rec(i + 1, b === blocks ? blocks + 1 : blocks);
      blockSums[b] -= price;
    }
  }
  if (n === 0) {
    return { totalPayable: 0, orderCount: 0, partitionsChecked: 1 };
  }
  rec(0, 0);
  return { totalPayable: bestCost, orderCount: bestOrders, partitionsChecked };
}
