import { orderCost } from "./pricing.js";
import type { CartRules, Coupon, Item } from "./types.js";

export interface BruteResult {
  totalPay: number;
  orderCount: number;
  partitionsChecked: number;
}

/**
 * 暴力枚举所有集合划分（限制增长串）× 券的单射分配，
 * 用于小件数（n <= 8）下与 DP 求解器对照。
 */
export function bruteForceSolve(
  items: Item[],
  rules: CartRules,
  coupons: Coupon[],
): BruteResult {
  const n = items.length;
  const c = coupons.length;
  if (n < 1 || n > 10) throw new Error("暴力枚举仅支持 1..10 件商品");

  let bestPay = Infinity;
  let bestOrders = 0x7fffffff;
  let partitionsChecked = 0;

  // 当前划分：blocks[b] = 该块商品小计
  const blocks: number[] = [];

  const consider = (blockCount: number): void => {
    partitionsChecked++;
    // 对每个块决定用哪张券（单射），递归求该划分下的最小实付
    let minPay = Infinity;
    const payNoCoupon = new Array<number>(blockCount);
    for (let b = 0; b < blockCount; b++) {
      payNoCoupon[b] = orderCost(blocks[b], rules, null).payable;
    }
    const used = new Array<boolean>(c).fill(false);
    const assign = (b: number, acc: number): void => {
      if (acc >= minPay) return; // 剪枝
      if (b === blockCount) {
        if (acc < minPay) minPay = acc;
        return;
      }
      assign(b + 1, acc + payNoCoupon[b]);
      for (let j = 0; j < c; j++) {
        if (used[j]) continue;
        used[j] = true;
        assign(b + 1, acc + orderCost(blocks[b], rules, coupons[j]).payable);
        used[j] = false;
      }
    };
    assign(0, 0);

    if (minPay < bestPay || (minPay === bestPay && blockCount < bestOrders)) {
      bestPay = minPay;
      bestOrders = blockCount;
    }
  };

  // 限制增长串：第 i 件商品可放入 0..maxBlock+1 号块
  const place = (i: number, blockCount: number): void => {
    if (i === n) {
      consider(blockCount);
      return;
    }
    const price = items[i].price;
    for (let b = 0; b < blockCount; b++) {
      blocks[b] += price;
      place(i + 1, blockCount);
      blocks[b] -= price;
    }
    blocks.push(price);
    place(i + 1, blockCount + 1);
    blocks.pop();
  };
  place(0, 0);

  return { totalPay: bestPay, orderCount: bestOrders, partitionsChecked };
}
