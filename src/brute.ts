import type { Certificate, Item } from "./types.js";
import { assignLayers, validateItems } from "./solver.js";

/**
 * 着色可行性：区间图贪心染色所需颜色数 == 最大重叠深度，
 * 子集可行当且仅当 <= k 色。返回所需颜色数。
 */
export function colorsNeeded(subset: Item[]): number {
  return assignLayers(subset).reduce((mx, a) => Math.max(mx, a.layer + 1), 0);
}

/** 并列 ID 序：特征向量规则 —— 按 id 升序找首个差异，包含该 id 者胜。 */
export function preferByIds(a: number[], b: number[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const all = [...new Set([...a, ...b])].sort((x, y) => x - y);
  for (const id of all) {
    const inA = setA.has(id);
    const inB = setB.has(id);
    if (inA !== inB) return inA ? -1 : 1;
  }
  return 0;
}

/**
 * 小子集枚举核对：枚举全部 2^n 个子集（n <= 20），
 * 用着色枚举判定可行性，取收益最大、并列按 ID 序的最优集。
 */
export function bruteForce(items: Item[], k: number): Certificate {
  validateItems(items);
  if (!Number.isInteger(k) || k < 0) throw new Error(`k 必须是非负整数：${k}`);
  let bestProfit = -1;
  let bestIds: number[] = [];
  const total = 1 << items.length;
  for (let mask = 0; mask < total; mask++) {
    const subset: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      if (mask & (1 << i)) subset.push(items[i]);
    }
    if (colorsNeeded(subset) > k) continue;
    const profit = subset.reduce((sum, it) => sum + it.priority, 0);
    const ids = subset.map((it) => it.id).sort((a, b) => a - b);
    if (profit > bestProfit || (profit === bestProfit && preferByIds(ids, bestIds) < 0)) {
      bestProfit = profit;
      bestIds = ids;
    }
  }
  const chosen = items.filter((it) => bestIds.includes(it.id));
  return {
    k,
    profit: bestProfit,
    count: bestIds.length,
    selected: bestIds,
    assignment: assignLayers(chosen),
  };
}
