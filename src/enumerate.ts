import { supplierCostCents } from "./cost";
import { better, buildSolution, infeasible } from "./solve";
import type { Solution, Supplier } from "./types";

/** 全枚举规模保护：组合数 C(demand+n-1, n-1) 随 demand 爆炸增长 */
export const ENUMERATION_MAX_DEMAND = 60;

/**
 * 全枚举求解：递归枚举每一家供应商的采购数量（0 或 >= moq），
 * 仅保留数量之和恰等于 demand 的组合，用于小需求下验收 DP 结果。
 */
export function solveByEnumeration(suppliers: Supplier[], demand: number): Solution {
  if (demand > ENUMERATION_MAX_DEMAND) {
    throw new Error(
      `demand ${demand} too large for full enumeration (limit ${ENUMERATION_MAX_DEMAND}); use DP solver`,
    );
  }
  const n = suppliers.length;
  const qtys = new Array<number>(n).fill(0);
  let best: { cost: number; count: number } | null = null;
  let bestQtys: number[] = [];

  function evaluate(): void {
    let cost = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const q = qtys[i]!;
      if (q === 0) continue;
      cost += supplierCostCents(suppliers[i]!, q);
      count += 1;
    }
    const cand = { cost, count };
    if (best === null || better(cand, best)) {
      best = cand;
      bestQtys = qtys.slice();
    }
  }

  function rec(i: number, remaining: number): void {
    if (i === n) {
      if (remaining === 0) evaluate();
      return;
    }
    const moq = suppliers[i]!.moq;
    qtys[i] = 0;
    rec(i + 1, remaining);
    for (let q = Math.max(moq, 1); q <= remaining; q++) {
      qtys[i] = q;
      rec(i + 1, remaining - q);
    }
    qtys[i] = 0;
  }

  rec(0, demand);
  if (best === null) return infeasible(demand);
  return buildSolution(suppliers, demand, bestQtys);
}
