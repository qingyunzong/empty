/**
 * 测试辅助：两个相互独立的最优解核对器。
 * - bruteForce：字面全枚举所有可行分配。
 * - dpSolve：按接收人/总额的精确动态规划（等价于全枚举）。
 * 两者都以 BigInt 计算精确平方偏差，并列时取 ID 升序字典序最大者。
 */
import {
  normalizeRecipients,
  type NormalizedRecipient,
  type Recipient,
} from "../src/split.js";

export interface Solution {
  cost: bigint;
  /** 与按 ID 升序排列的接收人一一对应的份额。 */
  alloc: number[];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** 归一化并按 ID 升序排序（字典序裁决的规范顺序）。 */
export function canonical(recipients: readonly Recipient[]): NormalizedRecipient[] {
  return normalizeRecipients(recipients).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

export function weightSum(norm: readonly NormalizedRecipient[]): bigint {
  return norm.reduce((s, r) => s + r.weightNum, 0n);
}

/** 精确平方偏差（公共分母 W^2 的分子；W=0 时为目标 0 的平方和）。 */
export function exactCost(
  alloc: readonly number[],
  norm: readonly NormalizedRecipient[],
  total: number,
): bigint {
  const wsum = weightSum(norm);
  let cost = 0n;
  for (let i = 0; i < norm.length; i++) {
    const diff =
      wsum === 0n
        ? BigInt(alloc[i]!)
        : BigInt(alloc[i]!) * wsum - BigInt(total) * norm[i]!.weightNum;
    cost += diff * diff;
  }
  return cost;
}

/** a 字典序大于 b 返回正数（等长数组）。 */
export function lexCompare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

function better(candidate: Solution, best: Solution | null): boolean {
  if (best === null) return true;
  if (candidate.cost !== best.cost) return candidate.cost < best.cost;
  return lexCompare(candidate.alloc, best.alloc) > 0;
}

/** 字面全枚举：仅适合很小规模。 */
export function bruteForce(
  total: number,
  recipients: readonly Recipient[],
): Solution | null {
  const norm = canonical(recipients);
  let best: Solution | null = null;
  const alloc = new Array<number>(norm.length).fill(0);
  const walk = (i: number, rest: number): void => {
    if (i === norm.length) {
      if (rest !== 0) return;
      const cost = exactCost(alloc, norm, total);
      const candidate = { cost, alloc: [...alloc] };
      if (better(candidate, best)) best = candidate;
      return;
    }
    const r = norm[i]!;
    // 剩余接收人的最小/最大可承接量，做可行性剪枝。
    let minRest = 0;
    let maxRest = 0;
    for (let j = i + 1; j < norm.length; j++) {
      minRest += norm[j]!.min;
      maxRest += norm[j]!.max;
    }
    const lo = Math.max(r.min, rest - maxRest);
    const hi = Math.min(r.max, rest - minRest);
    for (let a = lo; a <= hi; a++) {
      alloc[i] = a;
      walk(i + 1, rest - a);
    }
  };
  walk(0, total);
  return best;
}

/** 精确 DP：O(n * T^2)，可核对 8 人 / 100 分规模。 */
export function dpSolve(
  total: number,
  recipients: readonly Recipient[],
): Solution | null {
  const norm = canonical(recipients);
  const wsum = weightSum(norm);
  interface State {
    cost: bigint;
    alloc: number[];
  }
  let dp: (State | null)[] = new Array(total + 1).fill(null);
  dp[0] = { cost: 0n, alloc: [] };
  for (let i = 0; i < norm.length; i++) {
    const r = norm[i]!;
    const next: (State | null)[] = new Array(total + 1).fill(null);
    for (let s = 0; s <= total; s++) {
      const prev = dp[s];
      if (prev == null) continue;
      for (let a = r.min; a <= r.max && s + a <= total; a++) {
        const diff =
          wsum === 0n ? BigInt(a) : BigInt(a) * wsum - BigInt(total) * r.weightNum;
        const candidate: State = {
          cost: prev.cost + diff * diff,
          alloc: [...prev.alloc, a],
        };
        const cur = next[s + a];
        if (better(candidate, cur ?? null)) {
          next[s + a] = candidate;
        }
      }
    }
    dp = next;
  }
  return dp[total] ?? null;
}

/** 生成一个保证可行的随机实例（返回 null 表示放弃本组参数）。 */
export function randomInstance(
  rng: () => number,
  n: number,
  maxTotal: number,
): { total: number; recipients: Recipient[] } {
  const recipients: Recipient[] = [];
  for (let i = 0; i < n; i++) {
    const min = randInt(rng, 0, Math.floor(maxTotal / n));
    const max = min + randInt(rng, 0, maxTotal);
    recipients.push({
      id: String.fromCharCode(97 + i) + (i >= 26 ? String(i) : ""),
      weight: { num: randInt(rng, 0, 6), den: randInt(rng, 1, 5) },
      min,
      max,
    });
  }
  const minSum = recipients.reduce((s, r) => s + r.min, 0);
  const maxSum = recipients.reduce((s, r) => s + r.max, 0);
  const lo = Math.min(minSum, maxTotal);
  const hi = Math.min(maxSum, maxTotal);
  const total = randInt(rng, lo, hi);
  if (total < minSum || total > maxSum) {
    // 放宽：把总额夹到可行域内。
    return { total: Math.max(minSum, Math.min(maxSum, total)), recipients };
  }
  return { total, recipients };
}

export function sum(values: Iterable<number>): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}
