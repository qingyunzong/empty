/**
 * 完整精确重采样再加权模型（核对用基准）：
 * 对整条时间轴逐位置重新采样，独立重算每个有效样本的权重，
 * 并用 BigInt 有理数精确求窗口加权平均。
 */
import { GAP_CAP, PHASE_PERIOD } from "./weights.js";
import type { Cell } from "./types.js";

export interface Rational {
  num: bigint;
  den: bigint; // 恒为正，已约分
}

export interface ResampledPoint {
  valid: boolean;
  value: bigint;
  weight: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const r = x % y;
    x = y;
    y = r;
  }
  return x === 0n ? 1n : x;
}

function scanDistance(cells: readonly Cell[], t: number, dir: -1 | 1): number {
  let d = 0;
  let i = t;
  while (d < GAP_CAP) {
    i += dir;
    if (i < 0 || i >= cells.length) break;
    d++;
    if (cells[i] === null) return d;
  }
  return GAP_CAP;
}

/** 完整重采样：枚举每个时间位置，重建有效/缺失序列并重算权重。 */
export function resample(cells: readonly Cell[]): ResampledPoint[] {
  return cells.map((c, t) => {
    if (c === null) return { valid: false, value: 0n, weight: 0n };
    if (!Number.isInteger(c.value)) {
      throw new Error("exact model requires integer sample values");
    }
    if (!Number.isInteger(c.weight) || c.weight < 0) {
      throw new Error("exact model requires non-negative integer weights");
    }
    const dB = scanDistance(cells, t, -1);
    const dA = scanDistance(cells, t, 1);
    const weight =
      BigInt(c.weight) *
      BigInt(1 + (t % PHASE_PERIOD)) *
      BigInt((1 + dB) * (1 + dA));
    return { valid: true, value: BigInt(c.value), weight };
  });
}

/** 精确窗口加权平均：全零权重（权重和为 0）返回 null。 */
export function exactWindowAverage(
  cells: readonly Cell[],
  end: number,
  k: number,
): Rational | null {
  const timeline = resample(cells);
  if (!Number.isInteger(end) || end < 0 || end >= timeline.length) {
    throw new RangeError("end out of range");
  }
  let num = 0n;
  let den = 0n;
  let count = 0;
  for (let t = end; t >= 0 && count < k; t--) {
    const p = timeline[t];
    if (!p.valid) continue;
    num += p.weight * p.value;
    den += p.weight;
    count++;
  }
  if (den === 0n) return null;
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

export function rationalToNumber(r: Rational): number {
  return Number(r.num) / Number(r.den);
}
