/** 叶节点: 拨款直接落在这里, 收益由离散表给出(不保证凹). */
export interface LeafNode {
  kind: 'leaf';
  id: string;
  /** 该叶拨款下界(整数). */
  min: number;
  /** 该叶拨款上界(整数). */
  max: number;
  /** payoff[x] = 拨款 x 的收益, 数组长度须 >= max + 1. */
  payoff: number[];
  /** 固定启动费: 拨款 > 0 时一次性从总预算中扣除(不计入节点汇总). */
  startupFee?: number;
}

/** 内部节点: 对其子树拨款汇总施加上下界. */
export interface InternalNode {
  kind: 'internal';
  id: string;
  min: number;
  max: number;
  children: TreeNode[];
}

export type TreeNode = LeafNode | InternalNode;

/** 跨子树差值约束: |x[leafA] - x[leafB]| <= maxDiff. 每题最多 10 条. */
export interface CrossConstraint {
  leafA: string;
  leafB: string;
  maxDiff: number;
}

export interface Problem {
  root: TreeNode;
  /** 总预算(拨款 + 启动费), 必须 <= 80. */
  totalBudget: number;
  cross?: CrossConstraint[];
}

/** 跨边证书: 证明某条跨子树差值约束在解上成立. */
export interface CrossCertificate {
  leafA: string;
  leafB: string;
  xA: number;
  xB: number;
  diff: number;
  maxDiff: number;
  satisfied: boolean;
}

export type SolutionStatus =
  | 'optimal'   // 搜索闭合, 已证最优
  | 'feasible'  // 有可行解但搜索未闭合, 不得标最优
  | 'infeasible'// 搜索闭合且无可行解
  | 'unknown';  // 搜索未闭合且尚未找到可行解

export interface Solution {
  status: SolutionStatus;
  /** 搜索是否闭合(枚举空间耗尽). 未闭合时 status 绝不为 'optimal'. */
  closed: boolean;
  payoff: number;
  totalAllocated: number;
  totalFees: number;
  /** 各叶拨款. */
  allocation: Record<string, number>;
  /** 各节点(含内部节点与叶)汇总额. */
  nodeSums: Record<string, number>;
  /** 跨边证书, 每条跨子树约束一项. */
  crossCertificates: CrossCertificate[];
  /** 已探索的搜索节点数(工作预算的计量单位). */
  nodesExplored: number;
}
