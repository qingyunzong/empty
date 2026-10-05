import { compileProblem, maskToCaps, validateProblem } from "./solver";
import { Plan, PlanStep, Problem, Plugin } from "./types";

export interface BruteForceResult {
  cost: number;
  plan: Plan;
}

// 核对方法一：穷举全部 2^n 插件子集。
// 子集可行 <=> 从初始能力出发反复"点然"requires 已满足的插件，最终能点燃整个子集
// （点燃顺序即一个合法启用序列；点不然的剩余部分必含循环依赖，如自供/互供环）。
// 子集成本与顺序无关（各插件成本之和），故最小可行且覆盖目标的子集即最优。
export function bruteForceMinCost(problem: Problem): BruteForceResult | null {
  validateProblem(problem);
  const c = compileProblem(problem);
  const n = problem.plugins.length;
  const costs = problem.plugins.map((p) => p.cost);

  let bestCost = Infinity;
  let bestOrder: number[] = [];

  for (let subset = 0; subset < 1 << n; subset++) {
    let cost = 0;
    for (let i = 0; i < n; i++) if (subset & (1 << i)) cost += costs[i] as number;
    if (cost >= bestCost) continue; // 剪枝：已不优于当前最优

    let held = c.initialMask;
    let remaining = subset;
    const order: number[] = [];
    let progress = true;
    while (remaining !== 0 && progress) {
      progress = false;
      for (let i = 0; i < n; i++) {
        const bit = 1 << i;
        if (!(remaining & bit)) continue;
        const req = c.requiresMask[i] as number;
        if ((held & req) !== req) continue;
        held |= c.providesMask[i] as number;
        remaining ^= bit;
        order.push(i);
        progress = true;
      }
    }
    if (remaining !== 0) continue; // 子集不可行（含无法启动的环）
    if ((held & c.targetMask) !== c.targetMask) continue; // 未覆盖目标

    bestCost = cost;
    bestOrder = order;
  }

  if (bestCost === Infinity) return null;
  return { cost: bestCost, plan: buildPlan(problem, c, bestOrder) };
}

// 核对方法二：全状态空间松弛（Bellman-Ford 式定点迭代）。
// 与 Dijkstra 不同的独立算法：对所有 2^caps 状态反复松弛所有插件边直到不动点，
// 再取所有覆盖目标的状态中的最小距离。边只会通向超集状态，故必然收敛。
export function verifyByRelaxation(problem: Problem): number | null {
  validateProblem(problem);
  const c = compileProblem(problem);
  const size = 1 << c.caps.length;
  const dist = new Array<number>(size).fill(Infinity);
  dist[c.initialMask] = 0;

  let changed = true;
  while (changed) {
    changed = false;
    for (let s = 0; s < size; s++) {
      const d = dist[s] as number;
      if (d === Infinity) continue;
      for (let i = 0; i < problem.plugins.length; i++) {
        const req = c.requiresMask[i] as number;
        if ((s & req) !== req) continue;
        const ns = s | (c.providesMask[i] as number);
        const nd = d + (problem.plugins[i] as Plugin).cost;
        if (nd < (dist[ns] as number)) {
          dist[ns] = nd;
          changed = true;
        }
      }
    }
  }

  let best = Infinity;
  for (let s = 0; s < size; s++) {
    if ((s & c.targetMask) === c.targetMask) {
      const d = dist[s] as number;
      if (d < best) best = d;
    }
  }
  return best === Infinity ? null : best;
}

function buildPlan(problem: Problem, c: ReturnType<typeof compileProblem>, order: number[]): Plan {
  let held = c.initialMask;
  const steps: PlanStep[] = [];
  let totalCost = 0;
  for (const i of order) {
    const plugin = problem.plugins[i] as Plugin;
    held |= c.providesMask[i] as number;
    totalCost += plugin.cost;
    steps.push({ plugin, heldAfter: maskToCaps(c, held) });
  }
  return { initial: maskToCaps(c, c.initialMask), steps, totalCost };
}
