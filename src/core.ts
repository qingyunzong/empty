/**
 * 报价反推核心：
 *   每步对整数价格 x 计算  y = roundHalfEven(x * p / q)，
 *   给定最终舍入金额，反推所有满足条件的整数原价，输出互不交叠的闭区间。
 * 全部使用 BigInt 精确运算，避免浮点误差。
 */

export interface RationalStep {
  /** 分子 */
  readonly p: bigint;
  /** 分母 */
  readonly q: bigint;
}

/** 闭区间 [lo, hi]（含端点） */
export type Interval = readonly [bigint, bigint];

/** 原价定义域上界：10^12 */
export const MAX_ORIGINAL_PRICE = 1_000_000_000_000n;

export const MAX_STEPS = 8;

/** 解析 "p/q" 或整数 "p" 形式的有理折扣因子 */
export function parseStep(text: string): RationalStep {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(text.trim());
  if (!m || m[1] === undefined) {
    throw new Error(`无效的折扣步骤（应为正有理数 p/q）: ${text}`);
  }
  const p = BigInt(m[1]);
  const q = m[2] !== undefined ? BigInt(m[2]) : 1n;
  if (p <= 0n || q <= 0n) {
    throw new Error(`折扣因子必须为正有理数: ${text}`);
  }
  return { p, q };
}

/** 最近偶数舍入（round half to even），num >= 0, den > 0 */
export function roundHalfEven(num: bigint, den: bigint): bigint {
  const quot = num / den;
  const rem = num % den;
  const twice = 2n * rem;
  if (twice < den) return quot;
  if (twice > den) return quot + 1n;
  return quot % 2n === 0n ? quot : quot + 1n;
}

/** 单步前向计算 */
export function applyStep(x: bigint, step: RationalStep): bigint {
  return roundHalfEven(x * step.p, step.q);
}

/** 整条折扣链前向计算 */
export function forwardChain(steps: readonly RationalStep[], x: bigint): bigint {
  let v = x;
  for (const step of steps) v = applyStep(v, step);
  return v;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return a >= 0n ? (a + b - 1n) / b : -((-a) / b);
}

function floorDiv(a: bigint, b: bigint): bigint {
  return a >= 0n ? a / b : -((-a + b - 1n) / b);
}

/**
 * 单步反推：返回所有满足  a <= roundHalfEven(x*p/q) <= b  的整数 x 的闭区间；
 * 无解时返回 null。
 *
 * roundHalfEven(y) = n  ⟺
 *   y > n - 1/2 或 (y = n - 1/2 且 n 为偶数)，且
 *   y < n + 1/2 或 (y = n + 1/2 且 n 为偶数)。
 * 由于舍入关于 x 单调不减，输出区间 [a, b] 的原像为 [lo(a), hi(b)]。
 */
export function preimageInterval(
  step: RationalStep,
  a: bigint,
  b: bigint
): Interval | null {
  const { p, q } = step;
  const twoP = 2n * p;
  const lo =
    a % 2n === 0n
      ? ceilDiv((2n * a - 1n) * q, twoP)
      : floorDiv((2n * a - 1n) * q, twoP) + 1n;
  const hi =
    b % 2n === 0n
      ? floorDiv((2n * b + 1n) * q, twoP)
      : ceilDiv((2n * b + 1n) * q, twoP) - 1n;
  return lo <= hi ? [lo, hi] : null;
}

/** 合并区间：排序后把交叠或相邻（整数域上连续）的区间合并，结果互不交叠 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((u, v) =>
    u[0] < v[0] ? -1 : u[0] > v[0] ? 1 : 0
  );
  const merged: [bigint, bigint][] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && iv[0] <= last[1] + 1n) {
      if (iv[1] > last[1]) last[1] = iv[1];
    } else {
      merged.push([iv[0], iv[1]]);
    }
  }
  return merged;
}

/**
 * 从最终舍入金额 target 反推整条链的整数原价区间。
 * 结果限制在定义域 [domainLo, domainHi]（默认 [0, 10^12]）内，
 * 返回升序、互不交叠的闭区间数组。
 */
export function invertChain(
  steps: readonly RationalStep[],
  target: bigint,
  domainLo: bigint = 0n,
  domainHi: bigint = MAX_ORIGINAL_PRICE
): Interval[] {
  if (steps.length === 0 || steps.length > MAX_STEPS) {
    throw new Error(`折扣链步数必须在 1 到 ${MAX_STEPS} 之间，当前为 ${steps.length}`);
  }
  let intervals: Interval[] = [[target, target]];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step === undefined) throw new Error("unreachable");
    const next: Interval[] = [];
    for (const [a, b] of intervals) {
      const pre = preimageInterval(step, a, b);
      if (pre !== null) next.push(pre);
    }
    intervals = mergeIntervals(next);
    if (intervals.length === 0) break;
  }
  const result: Interval[] = [];
  for (const [lo, hi] of intervals) {
    const clampedLo = lo < domainLo ? domainLo : lo;
    const clampedHi = hi > domainHi ? domainHi : hi;
    if (clampedLo <= clampedHi) result.push([clampedLo, clampedHi]);
  }
  return result;
}

export interface VerifyReport {
  /** 低价域上限 */
  readonly limit: bigint;
  /** 区间内被逐值前向核验的整数个数 */
  readonly checked: bigint;
  /** 区间内但前向结果不等于 target 的值（应为空） */
  readonly mismatches: bigint[];
  /** 区间边界外但前向结果等于 target 的值（应为空） */
  readonly boundaryErrors: bigint[];
  /** 是否存在超出低价域上限、未能逐值核验的区间部分 */
  readonly truncated: boolean;
}

/**
 * 低价域逐值前向核验：
 * 对每个区间与 [0, limit] 的交集逐值前向计算，确认结果等于 target；
 * 同时检查区间边界外侧相邻值（在低价域内时）确实不等于 target。
 */
export function verifyLowDomain(
  steps: readonly RationalStep[],
  target: bigint,
  intervals: readonly Interval[],
  limit: bigint,
  domainLo: bigint = 0n,
  domainHi: bigint = MAX_ORIGINAL_PRICE
): VerifyReport {
  let checked = 0n;
  const mismatches: bigint[] = [];
  const boundaryErrors: bigint[] = [];
  let truncated = false;
  for (const [lo, hi] of intervals) {
    const cappedHi = hi < limit ? hi : limit;
    if (hi > limit) truncated = true;
    for (let x = lo; x <= cappedHi; x++) {
      checked++;
      if (forwardChain(steps, x) !== target) mismatches.push(x);
    }
    const below = lo - 1n;
    if (below >= domainLo && below <= limit && forwardChain(steps, below) === target) {
      boundaryErrors.push(below);
    }
    const above = hi + 1n;
    if (above <= domainHi && above <= limit && forwardChain(steps, above) === target) {
      boundaryErrors.push(above);
    }
  }
  return { limit, checked, mismatches, boundaryErrors, truncated };
}

/** 区间内整数值总个数 */
export function countValues(intervals: readonly Interval[]): bigint {
  let total = 0n;
  for (const [lo, hi] of intervals) total += hi - lo + 1n;
  return total;
}
