import { Candidate, lexLess } from './compare.js';
import { TreeNode } from './types.js';
import { validate } from './validate.js';
import { Problem } from './types.js';

interface DPEntry {
  payoff: number;
  /** 该子树内、按全局叶序的拨款向量. */
  amounts: number[];
}

/** 同一汇总 s 下的局部优胜序: 收益高者优先, 并列取向量字典序小者(total 同为 s). */
function betterEntry(a: DPEntry, b: DPEntry): DPEntry {
  if (a.payoff !== b.payoff) return a.payoff > b.payoff ? a : b;
  return lexLess(a.amounts, b.amounts) ? a : b;
}

/**
 * 树 DP: 每节点计算 "子树汇总恰为 s 时的最优(收益, 叶向量)" 表,
 * 自底向上做背包式卷积, 并在每节点应用其汇总上下界.
 * 仅适用于无耦合(无跨子树约束、无启动费)的问题.
 */
export function solveDP(problem: Problem): { candidate: Candidate; sum: number } | null {
  validate(problem);
  const budget = problem.totalBudget;

  const tableOf = (node: TreeNode): Map<number, DPEntry> => {
    if (node.kind === 'leaf') {
      const table = new Map<number, DPEntry>();
      for (let x = node.min; x <= Math.min(node.max, budget); x++) {
        table.set(x, { payoff: node.payoff[x], amounts: [x] });
      }
      return table;
    }
    let acc = new Map<number, DPEntry>([[0, { payoff: 0, amounts: [] }]]);
    const cap = Math.min(node.max, budget);
    for (const child of node.children) {
      const childTable = tableOf(child);
      const next = new Map<number, DPEntry>();
      for (const [s1, e1] of acc) {
        for (const [s2, e2] of childTable) {
          const s = s1 + s2;
          if (s > cap) continue;
          const cand: DPEntry = {
            payoff: e1.payoff + e2.payoff,
            amounts: e1.amounts.concat(e2.amounts),
          };
          const cur = next.get(s);
          if (!cur || betterEntry(cand, cur) === cand) next.set(s, cand);
        }
      }
      acc = next;
    }
    // 应用本节点汇总上下界
    for (const s of [...acc.keys()]) {
      if (s < node.min || s > node.max) acc.delete(s);
    }
    return acc;
  };

  const rootTable = tableOf(problem.root);
  let best: { candidate: Candidate; sum: number } | null = null;
  for (const [s, e] of rootTable) {
    if (s > budget) continue;
    const candidate: Candidate = { payoff: e.payoff, total: s, amounts: e.amounts };
    if (
      !best ||
      candidate.payoff > best.candidate.payoff ||
      (candidate.payoff === best.candidate.payoff &&
        (candidate.total < best.candidate.total ||
          (candidate.total === best.candidate.total &&
            lexLess(candidate.amounts, best.candidate.amounts))))
    ) {
      best = { candidate, sum: s };
    }
  }
  return best;
}
