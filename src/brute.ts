import { SubtitleItem } from "./model";

export interface BruteResult {
  profit: number;
  count: number;
  /** 选中 ID，字典序升序。 */
  ids: string[];
}

/**
 * 暴力枚举全部 2^n 子集用于核对（仅适合小规模）。
 * 可行性：区间图是完美图，子集可 k 层着色当且仅当任意时刻重叠深度 <= k。
 * 目标序与 solve 一致：收益大者优先，再条目数少者，再 ID 序字典序小者。
 */
export function bruteForce(items: SubtitleItem[], k: number): BruteResult {
  const n = items.length;
  let best: BruteResult = { profit: 0, count: 0, ids: [] };

  for (let mask = 0; mask < (1 << n); mask++) {
    const picked: SubtitleItem[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) picked.push(items[i]!);
    }
    if (maxDepth(picked) > k) continue;

    const ids = picked.map((it) => it.id).sort();
    const cand: BruteResult = {
      profit: picked.reduce((s, it) => s + it.priority, 0),
      count: picked.length,
      ids,
    };
    if (compare(cand, best) < 0) best = cand;
  }
  return best;
}

/** 扫描线求最大重叠深度（半开区间：同一时刻先结算结束再计入开始）。 */
export function maxDepth(items: SubtitleItem[]): number {
  const events: Array<[number, number]> = [];
  for (const it of items) {
    events.push([it.start, 1]);
    events.push([it.end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let depth = 0;
  let peak = 0;
  for (const [, delta] of events) {
    depth += delta;
    if (depth > peak) peak = depth;
  }
  return peak;
}

/** 返回负数表示 a 更优。 */
function compare(a: BruteResult, b: BruteResult): number {
  if (a.profit !== b.profit) return b.profit - a.profit;
  if (a.count !== b.count) return a.count - b.count;
  const len = Math.min(a.ids.length, b.ids.length);
  for (let i = 0; i < len; i++) {
    if (a.ids[i] !== b.ids[i]) return a.ids[i]! < b.ids[i]! ? -1 : 1;
  }
  return a.ids.length - b.ids.length;
}
