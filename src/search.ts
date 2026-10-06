import { Candidate, betterThan } from './compare.js';
import { Problem, Solution, TreeNode } from './types.js';
import {
  buildCrossCertificates,
  computeNodeSums,
  flatten,
  validate,
} from './validate.js';

/**
 * 静态预计算(全部可 JSON 序列化, 随状态保存以支持续算).
 */
interface SearchStatics {
  mins: number[];
  maxs: number[];
  fees: number[];
  /** payoffs[i][x]: 叶 i 拨款 x 的收益. */
  payoffs: number[][];
  /** ancestorsIdx[i]: 叶 i 的内部节点祖先下标. */
  ancestorsIdx: number[][];
  nodeMin: number[];
  nodeMax: number[];
  /** remMin[v][i]: 节点 v 中叶序 >= i 的未赋值叶的 min 之和. */
  remMin: number[][];
  remMax: number[][];
  /** crossByLeaf[i]: 涉及叶 i 的约束(对端叶下标, maxDiff). */
  crossByLeaf: { other: number; maxDiff: number }[][];
  /** suffix[i][b]: 叶 i..n-1 在剩余预算 b 下的收益上界(忽略节点界与跨约束, 计入启动费). */
  suffix: number[][];
}

/**
 * 可续算的分支限界搜索状态.
 * 不变式: 暂停时 values[0..frames.length-2] 已赋值且累加器与之对应.
 */
export interface SearchState {
  problem: Problem;
  n: number;
  statics: SearchStatics;
  frames: number[];
  values: number[];
  allocSum: number;
  feeSum: number;
  payoff: number;
  nodeSum: number[];
  best: Candidate | null;
  nodesExplored: number;
  closed: boolean;
}

export function createSearch(problem: Problem): SearchState {
  validate(problem);
  const { leaves, ancestors, nodes } = flatten(problem);
  const n = leaves.length;
  const budget = problem.totalBudget;

  const internal = nodes.filter((nd): nd is Extract<TreeNode, { kind: 'internal' }> => nd.kind === 'internal');
  const internalIdx = new Map<unknown, number>();
  internal.forEach((nd, i) => internalIdx.set(nd, i));

  // 每个内部节点的叶区间(先序下连续)
  const lo = internal.map(() => Infinity);
  const hi = internal.map(() => -Infinity);
  leaves.forEach((leaf, i) => {
    for (const anc of ancestors[i]) {
      const v = internalIdx.get(anc)!;
      lo[v] = Math.min(lo[v], i);
      hi[v] = Math.max(hi[v], i);
    }
  });

  const mins = leaves.map((l) => l.min);
  const maxs = leaves.map((l) => l.max);
  const fees = leaves.map((l) => l.startupFee ?? 0);
  const payoffs = leaves.map((l) => l.payoff.slice());
  const ancestorsIdx = ancestors.map((path) => path.map((a) => internalIdx.get(a)!));
  const nodeMin = internal.map((nd) => nd.min);
  const nodeMax = internal.map((nd) => nd.max);

  const remMin = internal.map((_, v) => {
    const arr = new Array<number>(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      arr[i] = arr[i + 1] + (i >= lo[v] && i <= hi[v] ? mins[i] : 0);
    }
    return arr;
  });
  const remMax = internal.map((_, v) => {
    const arr = new Array<number>(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      arr[i] = arr[i + 1] + (i >= lo[v] && i <= hi[v] ? maxs[i] : 0);
    }
    return arr;
  });

  const leafIndex = new Map<string, number>();
  leaves.forEach((l, i) => leafIndex.set(l.id, i));
  const crossByLeaf: { other: number; maxDiff: number }[][] = leaves.map(() => []);
  for (const c of problem.cross ?? []) {
    const a = leafIndex.get(c.leafA)!;
    const b = leafIndex.get(c.leafB)!;
    crossByLeaf[a].push({ other: b, maxDiff: c.maxDiff });
    crossByLeaf[b].push({ other: a, maxDiff: c.maxDiff });
  }

  // 后缀背包上界: 忽略节点汇总界与跨约束(松弛), 计入启动费
  const suffix: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(budget + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let b = 0; b <= budget; b++) {
      let bestVal = -Infinity;
      for (let x = mins[i]; x <= maxs[i]; x++) {
        const cost = x + (x > 0 ? fees[i] : 0);
        if (cost > b) break;
        const v = payoffs[i][x] + suffix[i + 1][b - cost];
        if (v > bestVal) bestVal = v;
      }
      suffix[i][b] = bestVal;
    }
  }

  return {
    problem,
    n,
    statics: {
      mins, maxs, fees, payoffs, ancestorsIdx,
      nodeMin, nodeMax, remMin, remMax, crossByLeaf, suffix,
    },
    frames: [mins[0]],
    values: [],
    allocSum: 0,
    feeSum: 0,
    payoff: 0,
    nodeSum: internal.map(() => 0),
    best: null,
    nodesExplored: 0,
    closed: false,
  };
}

function assign(state: SearchState, d: number, x: number): void {
  const S = state.statics;
  state.values[d] = x;
  state.allocSum += x;
  state.feeSum += x > 0 ? S.fees[d] : 0;
  state.payoff += S.payoffs[d][x];
  for (const v of S.ancestorsIdx[d]) state.nodeSum[v] += x;
}

function undo(state: SearchState, d: number): void {
  const S = state.statics;
  const x = state.values[d];
  state.allocSum -= x;
  state.feeSum -= x > 0 ? S.fees[d] : 0;
  state.payoff -= S.payoffs[d][x];
  for (const v of S.ancestorsIdx[d]) state.nodeSum[v] -= x;
}

function feasible(state: SearchState, d: number, x: number): boolean {
  const S = state.statics;
  for (const c of S.crossByLeaf[d]) {
    if (c.other < d && Math.abs(x - state.values[c.other]) > c.maxDiff) return false;
  }
  for (const v of S.ancestorsIdx[d]) {
    const s = state.nodeSum[v] + x;
    if (s + S.remMin[v][d + 1] > S.nodeMax[v]) return false;
    if (s + S.remMax[v][d + 1] < S.nodeMin[v]) return false;
  }
  return true;
}

function record(state: SearchState): void {
  const cand: Candidate = {
    payoff: state.payoff,
    total: state.allocSum,
    amounts: state.values.slice(0, state.n),
  };
  if (!state.best || betterThan(cand, state.best)) state.best = cand;
}

/**
 * 推进搜索, 最多消耗 workBudget 个节点访问量.
 * 预算耗尽即暂停(状态可序列化、可续算); 枚举空间耗尽则 closed = true.
 */
export function runSearch(state: SearchState, workBudget: number): SearchState {
  const S = state.statics;
  const budget = state.problem.totalBudget;
  let work = workBudget;
  while (state.frames.length > 0) {
    if (work <= 0) return state;
    work--;
    state.nodesExplored++;
    const d = state.frames.length - 1;
    const x = state.frames[d]++;
    if (x > S.maxs[d]) {
      state.frames.pop();
      if (d > 0) undo(state, d - 1);
      continue;
    }
    const cost = x + (x > 0 ? S.fees[d] : 0);
    if (state.allocSum + state.feeSum + cost > budget) {
      state.frames[d] = S.maxs[d] + 1; // 花费随 x 单调不减, 直接耗尽本层
      continue;
    }
    const remaining = budget - (state.allocSum + state.feeSum + cost);
    if (
      state.best &&
      state.payoff + S.payoffs[d][x] + S.suffix[d + 1][remaining] < state.best.payoff
    ) {
      continue; // 收益上界不足, 剪枝(等于时仍须探索以竞争平局序)
    }
    if (!feasible(state, d, x)) continue;
    assign(state, d, x);
    if (d === state.n - 1) {
      record(state);
      undo(state, d);
    } else {
      state.frames.push(S.mins[d + 1]);
    }
  }
  state.closed = true;
  return state;
}

/** 由(可能未闭合的)搜索状态构造解. 未闭合时绝不标 'optimal'. */
export function buildSolution(state: SearchState): Solution {
  const { problem, best, closed } = state;
  const leaves = flatten(problem).leaves;
  const allocation: Record<string, number> = {};
  let totalFees = 0;
  if (best) {
    leaves.forEach((leaf, i) => {
      allocation[leaf.id] = best.amounts[i];
      if (best.amounts[i] > 0) totalFees += leaf.startupFee ?? 0;
    });
  }
  const status: Solution['status'] = closed
    ? best
      ? 'optimal'
      : 'infeasible'
    : best
      ? 'feasible'
      : 'unknown';
  return {
    status,
    closed,
    payoff: best?.payoff ?? 0,
    totalAllocated: best?.total ?? 0,
    totalFees,
    allocation,
    nodeSums: best ? computeNodeSums(problem, allocation) : {},
    crossCertificates: best
      ? buildCrossCertificates(problem.cross ?? [], allocation)
      : [],
    nodesExplored: state.nodesExplored,
  };
}
