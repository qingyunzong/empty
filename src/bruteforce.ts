import { validateInput } from "./solver.js";
import type { ClearingInput } from "./types.js";

export const BRUTEFORCE_MAX_BILLS = 8;

export interface BruteForceResult {
  minPenalty: number;
  /** 达到最小罚费的 (支付子集, 执行顺序) 组合数。 */
  optimalPlanCount: number;
  /** 被枚举的排列总数（所有子集的全部排列）。 */
  permutationsChecked: number;
}

/**
 * 穷举验证：枚举每个子集的每一种执行顺序，逐步模拟余额，
 * 直接按定义求最小罚费。仅适用于 n ≤ 8（Σ C(n,k)·k! ≤ ⌊e·n!⌋）。
 */
export function solveBruteForce(input: ClearingInput): BruteForceResult {
  validateInput(input);
  const n = input.bills.length;
  if (n > BRUTEFORCE_MAX_BILLS) {
    throw new Error(`穷举验证仅支持 n ≤ ${BRUTEFORCE_MAX_BILLS}，实际 ${n}`);
  }
  const accounts = Object.keys(input.balances);
  const accIndex = new Map(accounts.map((a, i) => [a, i] as const));
  const init = accounts.map((a) => input.balances[a]!);
  const bills = input.bills.map((b) => ({
    from: accIndex.get(b.from)!,
    to: accIndex.get(b.to)!,
    amount: b.amount,
    penalty: b.penalty,
  }));
  const totalPenalty = bills.reduce((s, b) => s + b.penalty, 0);

  // 已付票据罚费之和的最大值；空子集（全部拒付）永远是合法方案，初始即为候选。
  let bestPaidPenalty = 0;
  let optimalPlanCount = 1;
  let permutationsChecked = 0;

  const bal = new Array<number>(accounts.length);
  const order: number[] = [];
  const used = new Array<boolean>(n).fill(false);

  // 递归枚举排列；在长度为 k 的前缀处结算“恰好支付该前缀集合”的方案。
  function dfs(paidPenaltySum: number): void {
    if (order.length > 0) {
      permutationsChecked++;
      if (paidPenaltySum > bestPaidPenalty) {
        bestPaidPenalty = paidPenaltySum;
        optimalPlanCount = 1;
      } else if (paidPenaltySum === bestPaidPenalty) {
        optimalPlanCount++;
      }
    }
    for (let b = 0; b < n; b++) {
      if (used[b]!) continue;
      const bill = bills[b]!;
      if (bal[bill.from]! < bill.amount) continue; // 执行时余额不足，不能作为下一步
      used[b] = true;
      bal[bill.from]! -= bill.amount;
      bal[bill.to]! += bill.amount;
      order.push(b);
      dfs(paidPenaltySum + bill.penalty);
      order.pop();
      bal[bill.from]! += bill.amount;
      bal[bill.to]! -= bill.amount;
      used[b] = false;
    }
  }

  bal.splice(0, bal.length, ...init);
  dfs(0);
  return {
    minPenalty: totalPenalty - bestPaidPenalty,
    optimalPlanCount,
    permutationsChecked,
  };
}
