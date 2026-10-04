import { supplierCostBreakdown, supplierCostCents } from "./cost";
import type { Allocation, Solution, Supplier } from "./types";

interface State {
  cost: number;
  count: number;
}

const UNREACHABLE: State = { cost: Number.POSITIVE_INFINITY, count: Number.POSITIVE_INFINITY };

/** 比较器：费用最小优先，费用相同则供应商数量少优先 */
export function better(a: State, b: State): boolean {
  return a.cost < b.cost || (a.cost === b.cost && a.count < b.count);
}

/** 由每家供应商的采购数量构造 Solution（qtys 与 suppliers 等长） */
export function buildSolution(suppliers: Supplier[], demand: number, qtys: number[]): Solution {
  let totalCents = 0;
  let supplierCount = 0;
  const allocations: Allocation[] = [];
  for (let i = 0; i < suppliers.length; i++) {
    const qty = qtys[i]!;
    if (qty === 0) continue;
    const supplier = suppliers[i]!;
    const parts = supplierCostBreakdown(supplier, qty);
    totalCents += parts.totalCents;
    supplierCount += 1;
    allocations.push({ supplierId: supplier.id, qty, ...parts });
  }
  return { feasible: true, demand, totalCents, supplierCount, allocations };
}

export function infeasible(demand: number): Solution {
  return { feasible: false, demand, totalCents: 0, supplierCount: 0, allocations: [] };
}

/**
 * 动态规划求解：dp[d] = 已处理的供应商恰好凑够数量 d 时的最优 (费用, 供应商数)。
 * 复杂度 O(供应商数 * demand^2)，demand=200、6 家供应商时约 24 万次状态转移。
 */
export function solve(suppliers: Supplier[], demand: number): Solution {
  if (demand < 0 || !Number.isInteger(demand)) {
    throw new Error(`demand must be a non-negative integer, got ${demand}`);
  }
  let dp: State[] = new Array<State>(demand + 1).fill(UNREACHABLE);
  dp[0] = { cost: 0, count: 0 };
  const choices: number[][] = [];

  for (const supplier of suppliers) {
    const costFor: number[] = new Array<number>(demand + 1);
    for (let q = 0; q <= demand; q++) costFor[q] = supplierCostCents(supplier, q);

    const next: State[] = new Array<State>(demand + 1).fill(UNREACHABLE);
    const choice = new Array<number>(demand + 1).fill(0);
    for (let d = 0; d <= demand; d++) {
      for (let q = 0; q <= d; q++) {
        const prev = dp[d - q]!;
        const cost = costFor[q]!;
        if (!Number.isFinite(prev.cost) || !Number.isFinite(cost)) continue;
        const cand: State = { cost: prev.cost + cost, count: prev.count + (q > 0 ? 1 : 0) };
        if (better(cand, next[d]!)) {
          next[d] = cand;
          choice[d] = q;
        }
      }
    }
    choices.push(choice);
    dp = next;
  }

  const best = dp[demand]!;
  if (!Number.isFinite(best.cost)) return infeasible(demand);

  const qtys = new Array<number>(suppliers.length).fill(0);
  let rest = demand;
  for (let i = suppliers.length - 1; i >= 0; i--) {
    const q = choices[i]![rest]!;
    qtys[i] = q;
    rest -= q;
  }
  return buildSolution(suppliers, demand, qtys);
}
