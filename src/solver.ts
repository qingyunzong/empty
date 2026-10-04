import { EPS, type Instance, type SolveResult } from "./types.js";
import { better } from "./route.js";

interface Label {
  /** 在 last 站完成服务的时刻 */
  time: number;
  /** 累计行驶路程（不含最后返回基地） */
  dist: number;
  prevMask: number;
  prevLast: number;
  prevIdx: number;
}

/**
 * 精确求解：子集 DP + Pareto 标签。
 * 状态 (mask, last) 保留互不支配的 (完成服务时刻, 累计路程) 标签；
 * 标签 a 支配 b 当且仅当 a.time <= b.time 且 a.dist <= b.dist。
 * n <= 16，mask 按数值递增遍历（超集 mask 必大于子集 mask）。
 */
export function solve(inst: Instance): SolveResult {
  const n = inst.n;
  const size = 1 << n;

  // 每个 mask 的收益（与顺序无关）
  const maskProfit = new Array<number>(size).fill(0);
  for (let mask = 1; mask < size; mask++) {
    const lsb = mask & -mask;
    const bit = 31 - Math.clz32(lsb);
    maskProfit[mask] = maskProfit[mask ^ lsb]! + inst.profit[bit + 1]!;
  }

  // states[mask][last-1] = 标签数组（last 为站点下标 1..n）
  const states: (Label[][] | undefined)[] = new Array(size).fill(undefined);

  const insert = (list: Label[], label: Label): void => {
    for (const e of list) {
      if (e.time <= label.time + EPS && e.dist <= label.dist + EPS) return; // 被支配
    }
    let w = 0;
    for (let r = 0; r < list.length; r++) {
      const e = list[r]!;
      if (!(label.time <= e.time + EPS && label.dist <= e.dist + EPS)) list[w++] = e;
    }
    list.length = w;
    list.push(label);
  };

  const ensure = (mask: number): Label[][] => {
    let s = states[mask];
    if (!s) {
      s = Array.from({ length: n }, () => []);
      states[mask] = s;
    }
    return s;
  };

  // 初始：基地直达首站
  for (let j = 1; j <= n; j++) {
    const d = inst.dist[0]![j]!;
    const start = Math.max(d, inst.open[j]!);
    if (start > inst.close[j]! + EPS) continue;
    const mask = 1 << (j - 1);
    insert(ensure(mask)[j - 1]!, {
      time: start + inst.service[j]!,
      dist: d,
      prevMask: 0,
      prevLast: 0,
      prevIdx: -1,
    });
  }

  // 扩展
  for (let mask = 1; mask < size; mask++) {
    const s = states[mask];
    if (!s) continue;
    for (let last = 1; last <= n; last++) {
      const labels = s[last - 1]!;
      if (labels.length === 0) continue;
      for (let j = 1; j <= n; j++) {
        const bit = 1 << (j - 1);
        if (mask & bit) continue;
        const travel = inst.dist[last]![j]!;
        const nmask = mask | bit;
        const target = ensure(nmask)[j - 1]!;
        for (let li = 0; li < labels.length; li++) {
          const L = labels[li]!;
          const arrive = L.time + travel;
          const start = Math.max(arrive, inst.open[j]!);
          if (start > inst.close[j]! + EPS) continue;
          insert(target, {
            time: start + inst.service[j]!,
            dist: L.dist + travel,
            prevMask: mask,
            prevLast: last,
            prevIdx: li,
          });
        }
      }
    }
  }

  // 收尾：返回基地，按时限过滤，按 (收益, -路程, -时间) 选优
  let best = { profit: 0, distance: 0, totalTime: 0 };
  let bestKey: { mask: number; last: number; idx: number } | null = null;
  for (let mask = 1; mask < size; mask++) {
    const s = states[mask];
    if (!s) continue;
    const profit = maskProfit[mask]!;
    if (profit < best.profit) continue;
    for (let last = 1; last <= n; last++) {
      const back = inst.dist[last]![0]!;
      const labels = s[last - 1]!;
      for (let idx = 0; idx < labels.length; idx++) {
        const L = labels[idx]!;
        const totalTime = L.time + back;
        if (totalTime > inst.timeLimit + EPS) continue;
        const cand = { profit, distance: L.dist + back, totalTime };
        if (bestKey === null || better(cand, best)) {
          best = cand;
          bestKey = { mask, last, idx };
        }
      }
    }
  }

  // 回溯访问顺序
  const route: number[] = [];
  if (bestKey) {
    let { mask, last, idx } = bestKey;
    while (mask !== 0) {
      route.push(last);
      const L = states[mask]![last - 1]![idx]!;
      mask = L.prevMask;
      last = L.prevLast;
      idx = L.prevIdx;
    }
    route.reverse();
  }
  return { profit: best.profit, distance: best.distance, totalTime: best.totalTime, route };
}
