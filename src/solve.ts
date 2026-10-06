import { bruteForce } from './bruteforce.js';
import { Candidate } from './compare.js';
import { solveDP } from './dp.js';
import { buildSolution, createSearch, runSearch, SearchState } from './search.js';
import { Problem, Solution } from './types.js';
import {
  buildCrossCertificates,
  computeNodeSums,
  flatten,
  hasCoupling,
  validate,
} from './validate.js';

export interface SolveOptions {
  /** 工作预算(搜索节点访问量上限); 仅对耦合问题生效, 缺省不限. */
  workBudget?: number;
  /** 传入既有状态以续算; 缺省新建. */
  state?: SearchState;
}

export interface SolveResult {
  solution: Solution;
  /** 耦合问题的可续算状态; 纯树 DP 路径为 undefined. */
  state?: SearchState;
}

/**
 * 求解入口.
 * 无耦合(无跨子树约束、无启动费): 树 DP, 一次闭合, 直接标最优.
 * 有耦合: 全局分支限界(不能独立优化子树再拼接), 支持工作预算与续算;
 *         未闭合时 status 为 'feasible'/'unknown', 绝不标 'optimal'.
 */
export function solve(problem: Problem, options: SolveOptions = {}): SolveResult {
  validate(problem);
  if (!hasCoupling(problem)) {
    const dp = solveDP(problem);
    const leaves = flatten(problem).leaves;
    const allocation: Record<string, number> = {};
    if (dp) leaves.forEach((leaf, i) => (allocation[leaf.id] = dp.candidate.amounts[i]));
    const solution: Solution = {
      status: dp ? 'optimal' : 'infeasible',
      closed: true,
      payoff: dp?.candidate.payoff ?? 0,
      totalAllocated: dp?.candidate.total ?? 0,
      totalFees: 0,
      allocation,
      nodeSums: dp ? computeNodeSums(problem, allocation) : {},
      crossCertificates: [],
      nodesExplored: 0,
    };
    return { solution };
  }
  const state = options.state ?? createSearch(problem);
  runSearch(state, options.workBudget ?? Number.MAX_SAFE_INTEGER);
  return { solution: buildSolution(state), state };
}

/** 叶向量枚举核验: 返回暴力枚举出的最优候选(闭合). */
export function verifyByEnumeration(problem: Problem): Candidate | null {
  return bruteForce(problem);
}

/**
 * 核验解与叶向量枚举结果是否一致(收益、总拨款、叶拨款向量).
 * 仅应在解闭合(closed)时用于判定最优性.
 */
export function solutionMatchesEnumeration(problem: Problem, solution: Solution): boolean {
  const candidate = bruteForce(problem);
  if (!candidate) return solution.status === 'infeasible';
  if (solution.payoff !== candidate.payoff) return false;
  if (solution.totalAllocated !== candidate.total) return false;
  const { leaves } = flatten(problem);
  return leaves.every((leaf, i) => solution.allocation[leaf.id] === candidate.amounts[i]);
}
