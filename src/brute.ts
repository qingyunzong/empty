/**
 * 独立核对器一：排列枚举（带禁配剪枝）。适用于小 n（建议 n <= 10）。
 * 独立核对器二：子集位掩码 DP，O(2^n * n^2)，适用于 n <= 20。
 */
import type { Problem } from "./solver.js";

export interface CrossResult {
  feasible: boolean;
  cost: number;
  perm: number[] | null;
}

export function bruteForcePermutation(problem: Problem): CrossResult {
  const n = problem.orderIds.length;
  let best = Infinity;
  let bestPerm: number[] | null = null;
  const perm = new Array<number>(n).fill(-1);
  const usedStation = new Array<boolean>(n).fill(false);

  // 合法下界剪枝：剩余行各自的最小允许费用之和（费用可为负，不能简单按 acc>=best 剪）。
  const rowMin = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let j = 0; j < n; j++) if (problem.allowed[i][j]) m = Math.min(m, problem.cost[i][j]);
    rowMin[i] = m;
  }
  const suffixMin = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffixMin[i] = suffixMin[i + 1] + rowMin[i];

  function dfs(i: number, acc: number): void {
    if (acc + suffixMin[i] >= best) return;
    if (i === n) {
      best = acc;
      bestPerm = perm.slice();
      return;
    }
    for (let j = 0; j < n; j++) {
      if (usedStation[j] || !problem.allowed[i][j]) continue;
      usedStation[j] = true;
      perm[i] = j;
      dfs(i + 1, acc + problem.cost[i][j]);
      usedStation[j] = false;
      perm[i] = -1;
    }
  }
  dfs(0, 0);
  return bestPerm === null
    ? { feasible: false, cost: Infinity, perm: null }
    : { feasible: true, cost: best, perm: bestPerm };
}

export function dpSolve(problem: Problem): CrossResult {
  const n = problem.orderIds.length;
  const size = 1 << n;
  const dp = new Array<number>(size).fill(Infinity);
  const parent = new Array<number>(size).fill(-1);
  dp[0] = 0;
  for (let mask = 0; mask < size; mask++) {
    const cur = dp[mask];
    if (cur === Infinity) continue;
    const i = popcount(mask);
    if (i >= n) continue;
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      if (!problem.allowed[i][j]) continue;
      const next = mask | (1 << j);
      const cand = cur + problem.cost[i][j];
      if (cand < dp[next]) {
        dp[next] = cand;
        parent[next] = j;
      }
    }
  }
  const full = size - 1;
  if (dp[full] === Infinity) return { feasible: false, cost: Infinity, perm: null };
  const perm = new Array<number>(n).fill(-1);
  let mask = full;
  for (let i = n - 1; i >= 0; i--) {
    const j = parent[mask];
    perm[i] = j;
    mask ^= 1 << j;
  }
  return { feasible: true, cost: dp[full], perm };
}

function popcount(x: number): number {
  let c = 0;
  while (x !== 0) {
    x &= x - 1;
    c++;
  }
  return c;
}
