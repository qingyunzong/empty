/**
 * 分账核心：按有理权重把整数总额拆成整数份额。
 *
 * 目标：在所有满足 min_i <= a_i <= max_i 且 sum(a) = total 的整数分配中，
 * 最小化精确平方偏差 sum( (a_i - t_i)^2 )，其中 t_i = total * w_i / W 为
 * 理想份额（W 为权重和）。并列最优时按 ID 升序取字典序最大者
 * （ID 小者优先获得分）。
 *
 * 算法：从下限出发，逐分（按批）把每一分分给"亏空" t_i - a_i 最大的
 * 未饱和接收人（最大余数法），余数相同按 ID 升序，达到上限者退出。
 * 对可分凸目标，该贪心即精确最优（Ibaraki–Katoh）；测试中用全枚举
 * 与动态规划交叉核对。
 */

export interface Rational {
  readonly num: number | bigint;
  readonly den: number | bigint;
}

export interface Recipient {
  readonly id: string;
  readonly weight: Rational;
  readonly min: number;
  readonly max: number;
}

export type SplitErrorCode = "INVALID_INPUT" | "INFEASIBLE";

export class SplitError extends Error {
  readonly code: SplitErrorCode;
  constructor(code: SplitErrorCode, message: string) {
    super(message);
    this.name = "SplitError";
    this.code = code;
  }
}

export interface NormalizedRecipient {
  readonly id: string;
  /** 权重通分后的整数分子（公共分母为各 den 的最小公倍数）。 */
  readonly weightNum: bigint;
  readonly min: number;
  readonly max: number;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function lcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (a / gcd(a, b)) * b;
}

function isSafeNonNegativeInteger(v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0;
}

/** 校验输入并把权重通分为整数分子。 */
export function normalizeRecipients(
  recipients: readonly Recipient[],
): NormalizedRecipient[] {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new SplitError("INVALID_INPUT", "recipients must be a non-empty array");
  }
  const seen = new Set<string>();
  let commonDen = 1n;
  const raw: { id: string; num: bigint; den: bigint; min: number; max: number }[] = [];
  for (const r of recipients) {
    if (typeof r.id !== "string" || r.id.length === 0) {
      throw new SplitError("INVALID_INPUT", "recipient id must be a non-empty string");
    }
    if (seen.has(r.id)) {
      throw new SplitError("INVALID_INPUT", `duplicate recipient id: ${r.id}`);
    }
    seen.add(r.id);
    if (!isSafeNonNegativeInteger(r.min) || !isSafeNonNegativeInteger(r.max)) {
      throw new SplitError("INVALID_INPUT", `min/max must be non-negative safe integers (id=${r.id})`);
    }
    if (r.min > r.max) {
      throw new SplitError("INVALID_INPUT", `min > max for recipient ${r.id}`);
    }
    const num = BigInt(r.weight.num);
    const den = BigInt(r.weight.den);
    if (num < 0n || den <= 0n) {
      throw new SplitError("INVALID_INPUT", `weight must be a non-negative rational (id=${r.id})`);
    }
    commonDen = lcm(commonDen, den);
    raw.push({ id: r.id, num, den, min: r.min, max: r.max });
  }
  return raw.map((r) => ({
    id: r.id,
    weightNum: r.num * (commonDen / r.den),
    min: r.min,
    max: r.max,
  }));
}

/**
 * 单次拆分。返回按输入顺序的 Map<id, 份额>。
 * 权重全为 0 时目标份额视为 0（即最小化 sum(a_i^2)，等价于尽量均分）。
 */
export function split(
  total: number,
  recipients: readonly Recipient[],
): Map<string, number> {
  if (!isSafeNonNegativeInteger(total)) {
    throw new SplitError("INVALID_INPUT", "total must be a non-negative safe integer");
  }
  const norm = normalizeRecipients(recipients);
  return new Map(norm.map((r, i) => [r.id, splitNormalized(total, norm)[i]!]));
}

/** 已归一化输入的拆分，返回与 norm 同序的份额数组。 */
export function splitNormalized(
  total: number,
  norm: readonly NormalizedRecipient[],
): number[] {
  let minSum = 0;
  let maxSum = 0;
  let weightSum = 0n;
  for (const r of norm) {
    minSum += r.min;
    maxSum += r.max;
    weightSum += r.weightNum;
  }
  if (minSum > total) {
    throw new SplitError(
      "INFEASIBLE",
      `sum of minimums (${minSum}) exceeds total (${total})`,
    );
  }
  if (maxSum < total) {
    throw new SplitError(
      "INFEASIBLE",
      `sum of maximums (${maxSum}) is below total (${total})`,
    );
  }

  const n = norm.length;
  const alloc = norm.map((r) => r.min);
  let remaining = total - minSum;

  // 并列时按 ID 升序优先，预先排好考察顺序。
  const order = norm.map((_, i) => i).sort((a, b) =>
    norm[a]!.id < norm[b]!.id ? -1 : norm[a]!.id > norm[b]!.id ? 1 : 0,
  );

  const totalBig = BigInt(total);
  // 亏空（最大余数）：t_i - a_i，通分后比较分子。
  // 权重和 > 0：deficit_i = total*w_i - a_i*W（公共分母 W，只比分子）。
  // 权重和 = 0：目标视为 0，deficit_i = -a_i，步长 1。
  const deficitOf = (i: number, a: number): bigint =>
    weightSum === 0n
      ? BigInt(-a)
      : totalBig * norm[i]!.weightNum - BigInt(a) * weightSum;
  const step = weightSum === 0n ? 1n : weightSum;

  while (remaining > 0) {
    let best = -1;
    let bestDeficit = 0n;
    let secondDeficit: bigint | null = null;
    for (const i of order) {
      if (alloc[i]! >= norm[i]!.max) continue; // 饱和者退出
      const d = deficitOf(i, alloc[i]!);
      if (best === -1 || d > bestDeficit) {
        secondDeficit = best === -1 ? null : bestDeficit;
        best = i;
        bestDeficit = d;
      } else if (secondDeficit === null || d > secondDeficit) {
        secondDeficit = d;
      }
    }
    if (best === -1) {
      // 不可达：maxSum >= total 已保证有未饱和者。
      throw new SplitError("INFEASIBLE", "no recipient can absorb the remainder");
    }
    // 批量：在 best 的亏空仍严格大于次优亏空期间，它必然独占每一
    // 分（无需 ID 裁决），可一次给足；一旦可能并列就停下来重新裁决。
    let batch: bigint;
    if (secondDeficit === null) {
      batch = BigInt(remaining);
    } else {
      batch = (bestDeficit - secondDeficit - 1n) / step + 1n;
      if (batch < 1n) batch = 1n;
    }
    const capacity = BigInt(norm[best]!.max - alloc[best]!);
    const left = BigInt(remaining);
    if (batch > capacity) batch = capacity;
    if (batch > left) batch = left;
    const give = Number(batch);
    alloc[best]! += give;
    remaining -= give;
  }
  return alloc;
}
