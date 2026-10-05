/** 一张不可拆票据：付款方 from 向收款方 to 支付 amount；拒付产生罚费 penalty。 */
export interface Bill {
  id: string;
  from: string;
  to: string;
  amount: number;
  penalty: number;
}

/** 清算输入：各账户初始余额 + 至多 16 笔票据。金额均为整数。 */
export interface ClearingInput {
  balances: Record<string, number>;
  bills: Bill[];
}

/** 求解结果。 */
export interface SolveResult {
  /** 最小总罚费（被拒付票据的罚费之和）。 */
  minPenalty: number;
  /** 实际支付的票据下标（按执行顺序）。 */
  paidOrder: number[];
  /** 被拒付的票据下标。 */
  refused: number[];
  /** 已支付子集的合法执行顺序总数（可能包含与 paidOrder 不同的其它合法序）。 */
  legalOrderCount: bigint;
  /** 全部 2^n 个子集中可合法执行（存在至少一个合法序）的子集个数。 */
  feasibleSubsetCount: number;
}
