// 小量穷举对照：枚举每个广告组 0..10 的全部组合，独立验证 DP 结果。
// 组合数为 11^n，仅在 11^n <= BRUTE_FORCE_LIMIT 时运行。
import type { PlanInput, Solution } from './model.js';
import { buildSolution } from './solve.js';

export const BRUTE_FORCE_LIMIT = 2_000_000;

export function bruteForceCombinations(numGroups: number): number {
  return Math.pow(11, numGroups);
}

export function canBruteForce(input: PlanInput): boolean {
  return bruteForceCombinations(input.groups.length) <= BRUTE_FORCE_LIMIT;
}

export function bruteForce(input: PlanInput): Solution {
  const n = input.groups.length;
  const combinations = bruteForceCombinations(n);
  if (combinations > BRUTE_FORCE_LIMIT) {
    throw new Error(`组合数 11^${n} = ${combinations} 超过穷举上限 ${BRUTE_FORCE_LIMIT}`);
  }
  const budgets = new Map(input.channels.map((c) => [c.id, c.budget]));
  const quantities = new Array<number>(n).fill(0);
  let best: { revenue: number; cost: number; quantities: number[] } | null = null;

  const spend = new Map<string, number>();
  const recurse = (gi: number, exposure: number, revenue: number, cost: number): void => {
    if (gi === n) {
      if (exposure < input.exposureLowerBound) return;
      if (best === null || revenue > best.revenue || (revenue === best.revenue && cost < best.cost)) {
        best = { revenue, cost, quantities: quantities.slice() };
      }
      return;
    }
    const group = input.groups[gi];
    const used = spend.get(group.channel) ?? 0;
    const budget = budgets.get(group.channel)!;
    for (let q = 0; q <= 10; q++) {
      const added = q * group.unitCost;
      if (used + added > budget) continue;
      quantities[gi] = q;
      spend.set(group.channel, used + added);
      recurse(gi + 1, exposure + q * group.unitExposure, revenue + group.revenue[q], cost + added);
    }
    quantities[gi] = 0;
    spend.set(group.channel, used);
  };
  recurse(0, 0, 0, 0);

  if (best === null) {
    return {
      status: 'infeasible',
      quantities: [],
      allocations: [],
      totalRevenue: 0,
      totalCost: 0,
      totalExposure: 0,
      channelSpend: Object.fromEntries(input.channels.map((c) => [c.id, 0])),
      statesExplored: combinations,
      frontierHash: '',
    };
  }
  const solution = buildSolution(input, (best as { quantities: number[] }).quantities, combinations);
  return solution;
}

/** 对照两种解法的结论是否一致（状态、收益、成本逐项相等）。 */
export function solutionsAgree(a: Solution, b: Solution): boolean {
  return a.status === b.status && a.totalRevenue === b.totalRevenue && a.totalCost === b.totalCost;
}
