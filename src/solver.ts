import type { Bill, ClearingInput, SolveResult } from "./types.js";

export const MAX_BILLS = 16;

/** 校验输入：至多 16 笔、金额/罚费为非负整数、支付金额为正、账户余额为整数。 */
export function validateInput(input: ClearingInput): void {
  if (!input || typeof input !== "object") throw new Error("输入必须是对象");
  const { balances, bills } = input;
  if (!balances || typeof balances !== "object") throw new Error("缺少 balances");
  if (!Array.isArray(bills)) throw new Error("bills 必须是数组");
  if (bills.length > MAX_BILLS) throw new Error(`票据至多 ${MAX_BILLS} 笔，实际 ${bills.length} 笔`);
  for (const [name, bal] of Object.entries(balances)) {
    if (!Number.isInteger(bal)) throw new Error(`账户 ${name} 的余额必须是整数`);
  }
  const seen = new Set<string>();
  bills.forEach((b: Bill, i: number) => {
    const tag = `票据[${i}]${b && b.id !== undefined ? ` id=${b.id}` : ""}`;
    if (!b || typeof b !== "object") throw new Error(`${tag} 非法`);
    if (typeof b.id !== "string" || b.id.length === 0) throw new Error(`${tag} 缺少 id`);
    if (seen.has(b.id)) throw new Error(`票据 id 重复: ${b.id}`);
    seen.add(b.id);
    if (typeof b.from !== "string" || typeof b.to !== "string") throw new Error(`${tag} 缺少 from/to`);
    if (!(b.from in balances)) throw new Error(`${tag} 付款方 ${b.from} 无初始余额记录`);
    if (!(b.to in balances)) throw new Error(`${tag} 收款方 ${b.to} 无初始余额记录`);
    if (!Number.isInteger(b.amount) || b.amount <= 0) throw new Error(`${tag} 金额必须是正整数`);
    if (!Number.isInteger(b.penalty) || b.penalty < 0) throw new Error(`${tag} 罚费必须是非负整数`);
  });
}

interface Model {
  accounts: string[];
  init: number[];
  from: number[];
  to: number[];
  amount: number[];
  penalty: number[];
  n: number;
  size: number;
  /** net[S * A + a]：恰好支付子集 S 后账户 a 的净变动（与顺序无关）。 */
  net: Float64Array;
  /** penSum[S]：子集 S 内票据的罚费之和。 */
  penSum: Float64Array;
}

function buildModel(input: ClearingInput): Model {
  const accounts = Object.keys(input.balances);
  const accIndex = new Map(accounts.map((a, i) => [a, i] as const));
  const n = input.bills.length;
  const size = 1 << n;
  const A = accounts.length;
  const init = accounts.map((a) => input.balances[a]!);
  const from = input.bills.map((b) => accIndex.get(b.from)!);
  const to = input.bills.map((b) => accIndex.get(b.to)!);
  const amount = input.bills.map((b) => b.amount);
  const penalty = input.bills.map((b) => b.penalty);
  const net = new Float64Array(size * A);
  const penSum = new Float64Array(size);
  for (let s = 1; s < size; s++) {
    const low = s & -s;
    const b = 31 - Math.clz32(low);
    const prev = s ^ low;
    const po = prev * A;
    const so = s * A;
    for (let a = 0; a < A; a++) net[so + a] = net[po + a]!;
    net[so + from[b]!] = net[so + from[b]!]! - amount[b]!;
    net[so + to[b]!] = net[so + to[b]!]! + amount[b]!;
    penSum[s] = penSum[prev]! + penalty[b]!;
  }
  return { accounts, init, from, to, amount, penalty, n, size, net, penSum };
}

export interface DpTables {
  /** feasible[S]：子集 S 是否存在合法执行顺序（逆推 DP）。 */
  feasible: Uint8Array;
  /** parent[S]：重构用——S 的某个合法序中最后执行的票据。 */
  parent: Int32Array;
  /** orderCount[S]：子集 S 的合法执行顺序总数（精确，BigInt）。 */
  orderCount: BigInt64Array;
  model: Model;
}

/**
 * 逆推子集 DP：S 合法 ⟺ 存在 b∈S，S\{b} 合法且付完 S\{b} 后 from(b) 余额 ≥ amount(b)。
 * “付完某子集后的余额”与顺序无关，只取决于子集本身，因此该 DP 是精确的。
 */
export function computeDp(input: ClearingInput): DpTables {
  validateInput(input);
  const m = buildModel(input);
  const { size, from, amount, init, net } = m;
  const A = m.accounts.length;
  const feasible = new Uint8Array(size);
  const parent = new Int32Array(size).fill(-1);
  const orderCount = new BigInt64Array(size);
  feasible[0] = 1;
  orderCount[0] = 1n;
  for (let s = 1; s < size; s++) {
    let count = 0n;
    let rest = s;
    while (rest !== 0) {
      const low = rest & -rest;
      const b = 31 - Math.clz32(low);
      rest ^= low;
      const prev = s ^ low;
      if (feasible[prev] === 0) continue;
      const bal = init[from[b]!]! + net[prev * A + from[b]!]!;
      if (bal >= amount[b]!) {
        if (feasible[s] === 0) {
          feasible[s] = 1;
          parent[s] = b;
        }
        count += orderCount[prev]!;
      }
    }
    orderCount[s] = count;
  }
  return { feasible, parent, orderCount, model: m };
}

/** 正向子集 DP（独立实现，用于交叉验证）：从空集出发，只加入当前付得起的票据。 */
export function computeReachableForward(input: ClearingInput): Uint8Array {
  validateInput(input);
  const m = buildModel(input);
  const { size, from, amount, init, net } = m;
  const A = m.accounts.length;
  const reach = new Uint8Array(size);
  reach[0] = 1;
  for (let s = 0; s < size; s++) {
    if (reach[s] === 0) continue;
    for (let b = 0; b < m.n; b++) {
      const bit = 1 << b;
      if ((s & bit) !== 0) continue;
      const bal = init[from[b]!]! + net[s * A + from[b]!]!;
      if (bal >= amount[b]!) reach[s | bit] = 1;
    }
  }
  return reach;
}

/** 求解：在所有可合法执行的子集中，最大化“已付票据罚费之和”，即最小化拒付罚费。 */
export function solve(input: ClearingInput): SolveResult {
  const dp = computeDp(input);
  const m = dp.model;
  const totalPenalty = m.penalty.reduce((a, b) => a + b, 0);
  let best = 0;
  for (let s = 1; s < m.size; s++) {
    if (dp.feasible[s] === 1 && m.penSum[s]! > m.penSum[best]!) best = s;
  }
  // 重构一个合法执行序：沿 parent 从后往前取“最后执行的票据”。
  const paidOrder: number[] = [];
  let cur = best;
  while (cur !== 0) {
    const b = dp.parent[cur]!;
    paidOrder.push(b);
    cur ^= 1 << b;
  }
  paidOrder.reverse();
  const refused: number[] = [];
  for (let b = 0; b < m.n; b++) if ((best & (1 << b)) === 0) refused.push(b);
  let feasibleSubsetCount = 0;
  for (let s = 0; s < m.size; s++) if (dp.feasible[s] === 1) feasibleSubsetCount++;
  return {
    minPenalty: totalPenalty - m.penSum[best]!,
    paidOrder,
    refused,
    legalOrderCount: dp.orderCount[best]!,
    feasibleSubsetCount,
  };
}
