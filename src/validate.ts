import { CrossConstraint, InternalNode, LeafNode, Problem, TreeNode } from './types.js';

export const MAX_TOTAL_BUDGET = 80;
export const MAX_CROSS_CONSTRAINTS = 10;

/** 扁平化后的树, 供 DP / 搜索 / 枚举共用. */
export interface FlatProblem {
  root: TreeNode;
  /** 先序(文档序)叶列表. */
  leaves: LeafNode[];
  leafIndex: Map<string, number>;
  /** 全部节点(先序). */
  nodes: TreeNode[];
  /** ancestors[i] = 叶 i 的内部节点祖先, 自根向下. */
  ancestors: InternalNode[][];
}

function assertInt(value: number, what: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${what} 必须为整数, 得到 ${value}`);
  }
}

export function validate(problem: Problem): void {
  assertInt(problem.totalBudget, 'totalBudget');
  if (problem.totalBudget < 0 || problem.totalBudget > MAX_TOTAL_BUDGET) {
    throw new Error(`totalBudget 必须在 [0, ${MAX_TOTAL_BUDGET}] 内, 得到 ${problem.totalBudget}`);
  }
  const cross = problem.cross ?? [];
  if (cross.length > MAX_CROSS_CONSTRAINTS) {
    throw new Error(`跨子树差值约束最多 ${MAX_CROSS_CONSTRAINTS} 条, 得到 ${cross.length} 条`);
  }
  const ids = new Set<string>();
  const leafIds = new Set<string>();
  const walk = (node: TreeNode): void => {
    if (ids.has(node.id)) throw new Error(`节点 id 重复: ${node.id}`);
    ids.add(node.id);
    assertInt(node.min, `节点 ${node.id} 的 min`);
    assertInt(node.max, `节点 ${node.id} 的 max`);
    if (node.min < 0) throw new Error(`节点 ${node.id} 的 min 不能为负`);
    if (node.min > node.max) throw new Error(`节点 ${node.id} 的 min > max`);
    if (node.kind === 'leaf') {
      leafIds.add(node.id);
      if (!Array.isArray(node.payoff) || node.payoff.length < node.max + 1) {
        throw new Error(`叶 ${node.id} 的收益表长度须 >= max+1 (${node.max + 1})`);
      }
      for (let x = node.min; x <= node.max; x++) {
        if (!Number.isFinite(node.payoff[x])) {
          throw new Error(`叶 ${node.id} 的收益表 payoff[${x}] 非有限数`);
        }
      }
      if (node.startupFee !== undefined) {
        assertInt(node.startupFee, `叶 ${node.id} 的 startupFee`);
        if (node.startupFee < 0) throw new Error(`叶 ${node.id} 的 startupFee 不能为负`);
      }
    } else {
      if (node.children.length === 0) throw new Error(`内部节点 ${node.id} 至少需要一个子节点`);
      for (const child of node.children) walk(child);
    }
  };
  walk(problem.root);
  for (const c of cross) {
    assertInt(c.maxDiff, '跨子树约束 maxDiff');
    if (c.maxDiff < 0) throw new Error('跨子树约束 maxDiff 不能为负');
    if (!leafIds.has(c.leafA)) throw new Error(`跨子树约束引用了不存在的叶: ${c.leafA}`);
    if (!leafIds.has(c.leafB)) throw new Error(`跨子树约束引用了不存在的叶: ${c.leafB}`);
    if (c.leafA === c.leafB) throw new Error(`跨子树约束两端相同: ${c.leafA}`);
  }
}

export function flatten(problem: Problem): FlatProblem {
  const leaves: LeafNode[] = [];
  const nodes: TreeNode[] = [];
  const ancestors: InternalNode[][] = [];
  const walk = (node: TreeNode, path: InternalNode[]): void => {
    nodes.push(node);
    if (node.kind === 'leaf') {
      leaves.push(node);
      ancestors.push(path);
    } else {
      for (const child of node.children) walk(child, [...path, node]);
    }
  };
  walk(problem.root, []);
  const leafIndex = new Map<string, number>();
  leaves.forEach((leaf, i) => leafIndex.set(leaf.id, i));
  return { root: problem.root, leaves, leafIndex, nodes, ancestors };
}

/** 是否存在使子树无法独立优化的耦合(跨子树约束或启动费). */
export function hasCoupling(problem: Problem): boolean {
  if ((problem.cross ?? []).length > 0) return true;
  let coupled = false;
  const walk = (node: TreeNode): void => {
    if (node.kind === 'leaf') {
      if ((node.startupFee ?? 0) > 0) coupled = true;
    } else {
      node.children.forEach(walk);
    }
  };
  walk(problem.root);
  return coupled;
}

/** 由叶拨款向量计算所有节点的汇总额. */
export function computeNodeSums(problem: Problem, allocation: Record<string, number>): Record<string, number> {
  const sums: Record<string, number> = {};
  const walk = (node: TreeNode): number => {
    if (node.kind === 'leaf') {
      const x = allocation[node.id] ?? 0;
      sums[node.id] = x;
      return x;
    }
    let s = 0;
    for (const child of node.children) s += walk(child);
    sums[node.id] = s;
    return s;
  };
  walk(problem.root);
  return sums;
}

/** 生成跨边证书. */
export function buildCrossCertificates(
  cross: CrossConstraint[],
  allocation: Record<string, number>,
) {
  return cross.map((c) => {
    const xA = allocation[c.leafA] ?? 0;
    const xB = allocation[c.leafB] ?? 0;
    const diff = Math.abs(xA - xB);
    return {
      leafA: c.leafA,
      leafB: c.leafB,
      xA,
      xB,
      diff,
      maxDiff: c.maxDiff,
      satisfied: diff <= c.maxDiff,
    };
  });
}
