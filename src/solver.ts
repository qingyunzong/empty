import { frac, add, mul, div, sub, lcm, type Fraction } from "./fraction.js";

export interface Liquid {
  /** 该液体的浓度（精确有理数）。 */
  concentration: Fraction;
  /** 每单位量的整数成本，须 >= 0。 */
  cost: bigint;
}

export interface Solution {
  /** 每种液体的整数用量。 */
  amounts: number[];
  /** 总用量（>= 1 且 <= maxTotal）。 */
  total: number;
  /** 最小总成本。 */
  cost: bigint;
  /** 混合后的精确浓度。 */
  concentration: Fraction;
}

export const MAX_LIQUIDS = 12;
export const MAX_TOTAL = 40;

/**
 * 精确求解整数配比问题：
 *   选 x_i ∈ Z_{\ge 0}，1 <= Σx_i <= maxTotal，
 *   使 lo <= Σ(c_i·x_i)/Σx_i <= hi（有理闭区间），
 *   先最小化 Σcost_i·x_i，并列时取用量向量字典序最小者。
 *
 * 浓度约束等价于两个线性约束（对 Σx_i > 0 两边同乘分母，精确成立）：
 *   Σ(c_i - lo)·x_i >= 0 且 Σ(hi - c_i)·x_i >= 0。
 * 系数通分为整数后用分支限界做完备搜索：无解时一定搜完全部可能才返回 null。
 */
export function solve(
  liquids: Liquid[],
  lo: Fraction,
  hi: Fraction,
  maxTotal: number = MAX_TOTAL,
): Solution | null {
  const n = liquids.length;
  if (n < 1 || n > MAX_LIQUIDS) throw new Error(`液体种类须为 1..${MAX_LIQUIDS}，当前 ${n}`);
  if (!Number.isInteger(maxTotal) || maxTotal < 1 || maxTotal > MAX_TOTAL)
    throw new Error(`总量上限须为 1..${MAX_TOTAL} 的整数，当前 ${maxTotal}`);
  if (sub(hi, lo).n < 0n) throw new Error("目标区间下界大于上界");
  for (const l of liquids)
    if (l.cost < 0n) throw new Error("成本须为非负整数");

  // 通分：A_i = (c_i - lo)·L，B_i = (hi - c_i)·L 均为整数。
  const aF = liquids.map((l) => sub(l.concentration, lo));
  const bF = liquids.map((l) => sub(hi, l.concentration));
  let L = 1n;
  for (const f of aF) L = lcm(L, f.d);
  for (const f of bF) L = lcm(L, f.d);
  const A = aF.map((f) => f.n * (L / f.d));
  const B = bF.map((f) => f.n * (L / f.d));
  const costs = liquids.map((l) => l.cost);

  // 后缀最大值，用于可行性剪枝。
  const maxA = new Array<bigint>(n + 1).fill(0n);
  const maxB = new Array<bigint>(n + 1).fill(0n);
  const maxCost = new Array<bigint>(n + 1).fill(0n);
  for (let i = n - 1; i >= 0; i--) {
    maxA[i] = A[i] > maxA[i + 1] ? A[i] : maxA[i + 1];
    maxB[i] = B[i] > maxB[i + 1] ? B[i] : maxB[i + 1];
    maxCost[i] = costs[i] > maxCost[i + 1] ? costs[i] : maxCost[i + 1];
  }

  // 第一阶段：分支限界求最小成本。
  let best: bigint | null = null;
  const dfsCost = (
    i: number,
    rem: number,
    sumA: bigint,
    sumB: bigint,
    cost: bigint,
    used: number,
  ): void => {
    if (used > 0 && sumA >= 0n && sumB >= 0n && (best === null || cost < best)) best = cost;
    if (i === n || rem === 0) return;
    if (best !== null && cost >= best) return; // 成本非负，继续只会更贵
    const remB = BigInt(rem);
    if (sumA + maxA[i] * remB < 0n) return; // 剩余容量无法拉回浓度下界
    if (sumB + maxB[i] * remB < 0n) return; // 剩余容量无法拉回浓度上界
    const ci = costs[i];
    const ai = A[i];
    const bi = B[i];
    for (let k = 0; k <= rem; k++) {
      const ncost = cost + ci * BigInt(k);
      if (best !== null && ncost >= best) break;
      dfsCost(i + 1, rem - k, sumA + ai * BigInt(k), sumB + bi * BigInt(k), ncost, used + k);
    }
  };
  dfsCost(0, maxTotal, 0n, 0n, 0n, 0);
  if (best === null) return null;

  // 第二阶段：成本固定为 best，按字典序升序找第一个可行向量。
  const target = best;
  const x = new Array<number>(n).fill(0);
  const dfsLex = (
    i: number,
    rem: number,
    sumA: bigint,
    sumB: bigint,
    cost: bigint,
    used: number,
  ): boolean => {
    if (cost === target && used > 0 && sumA >= 0n && sumB >= 0n) return true;
    if (i === n || rem === 0 || cost > target) return false;
    const remB = BigInt(rem);
    if (sumA + maxA[i] * remB < 0n) return false;
    if (sumB + maxB[i] * remB < 0n) return false;
    if (cost + maxCost[i] * remB < target) return false; // 剩余容量凑不到目标成本
    const ci = costs[i];
    const ai = A[i];
    const bi = B[i];
    for (let k = 0; k <= rem; k++) {
      const ncost = cost + ci * BigInt(k);
      if (ncost > target) break;
      x[i] = k;
      if (dfsLex(i + 1, rem - k, sumA + ai * BigInt(k), sumB + bi * BigInt(k), ncost, used + k))
        return true;
    }
    x[i] = 0;
    return false;
  };
  if (!dfsLex(0, maxTotal, 0n, 0n, 0n, 0)) throw new Error("内部错误：第二阶段未找到解");

  let total = 0;
  let conc = frac(0n);
  for (let i = 0; i < n; i++) {
    total += x[i];
    conc = add(conc, mul(liquids[i].concentration, frac(BigInt(x[i]))));
  }
  conc = div(conc, frac(BigInt(total)));
  return { amounts: x, total, cost: target, concentration: conc };
}
