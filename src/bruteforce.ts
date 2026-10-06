import { Candidate, betterThan } from './compare.js';
import { Problem } from './types.js';
import { flatten, validate } from './validate.js';

/**
 * 叶向量枚举核验器: 穷举全部叶拨款向量, 逐一检查
 * 总预算(含启动费)、各节点汇总上下界、跨子树差值约束,
 * 按全局优胜序取最优. 用于小规模实例上核验 DP / 搜索结果.
 */
export function bruteForce(problem: Problem): Candidate | null {
  validate(problem);
  const { leaves, nodes, ancestors } = flatten(problem);
  const cross = problem.cross ?? [];
  const budget = problem.totalBudget;
  const n = leaves.length;
  const values = new Array<number>(n).fill(0);
  let best: Candidate | null = null;

  const fees = leaves.map((l) => l.startupFee ?? 0);

  const checkNodeBounds = (): boolean => {
    // 自叶向上累计并检查每个节点的汇总上下界
    const sum = new Map<unknown, number>();
    for (let i = 0; i < n; i++) {
      const leaf = leaves[i];
      if (values[i] < leaf.min || values[i] > leaf.max) return false;
      sum.set(leaf, values[i]);
      for (const anc of ancestors[i]) {
        sum.set(anc, (sum.get(anc) ?? 0) + values[i]);
      }
    }
    for (const node of nodes) {
      const s = sum.get(node) ?? 0;
      if (s < node.min || s > node.max) return false;
    }
    return true;
  };

  const checkCross = (): boolean => {
    for (const c of cross) {
      const a = values[leaves.findIndex((l) => l.id === c.leafA)];
      const b = values[leaves.findIndex((l) => l.id === c.leafB)];
      if (Math.abs(a - b) > c.maxDiff) return false;
    }
    return true;
  };

  const recurse = (i: number, spent: number, payoff: number, alloc: number): void => {
    if (i === n) {
      if (!checkNodeBounds() || !checkCross()) return;
      const cand: Candidate = { payoff, total: alloc, amounts: values.slice() };
      if (!best || betterThan(cand, best)) best = cand;
      return;
    }
    const leaf = leaves[i];
    for (let x = leaf.min; x <= leaf.max; x++) {
      const fee = x > 0 ? fees[i] : 0;
      const nextSpent = spent + x + fee;
      if (nextSpent > budget) break; // x 递增, 花费单调不减
      values[i] = x;
      recurse(i + 1, nextSpent, payoff + leaf.payoff[x], alloc + x);
    }
  };
  recurse(0, 0, 0, 0);
  return best;
}
