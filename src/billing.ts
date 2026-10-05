import {
  Interval,
  assertValidInterval,
  durationSeconds,
  intersectIntervals,
  unionIntervals,
} from "./interval.js";

/** 费率区间：[start, end) 内每分钟 rateCentsPerMin 分。 */
export interface RateInterval extends Interval {
  rateCentsPerMin: number;
}

/** 计费来源段：上线区间并集与费率区间的交集。 */
export interface Segment {
  start: number;
  end: number;
  rateCentsPerMin: number;
  /** 该段向上取整后的计费分钟数。 */
  minutes: number;
  /** 该段费用（分）。 */
  feeCents: number;
}

export function assertValidRates(rates: RateInterval[]): void {
  for (const r of rates) {
    assertValidInterval(r);
    if (!Number.isInteger(r.rateCentsPerMin) || r.rateCentsPerMin < 0) {
      throw new Error(`费率必须为非负整数（分/分钟）: ${r.rateCentsPerMin}`);
    }
  }
  const sorted = [...rates].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) {
      throw new Error(
        `费率区间重叠: [${sorted[i - 1]!.start}, ${sorted[i - 1]!.end}) 与 [${sorted[i]!.start}, ${sorted[i]!.end})`,
      );
    }
  }
}

/** 每段秒数向上计分钟。 */
export function ceilMinutes(seconds: number): number {
  return Math.ceil(seconds / 60);
}

/**
 * 计费主流程：
 * 1. 上线区间先求并集（重叠/相邻合并）；
 * 2. 并集与费率区间求交，得到来源段；
 * 3. 每段秒数向上计分钟，乘费率得费用。
 */
export function buildSegments(online: Interval[], rates: RateInterval[]): Segment[] {
  assertValidRates(rates);
  const unioned = unionIntervals(online);
  const sortedRates = [...rates]
    .map((r) => ({ start: r.start, end: r.end, rateCentsPerMin: r.rateCentsPerMin }))
    .sort((a, b) => a.start - b.start);
  const hits = intersectIntervals(unioned, sortedRates);
  return hits.map((hit) => {
    const rate = sortedRates.find((r) => r.start <= hit.start && hit.end <= r.end)!;
    const minutes = ceilMinutes(durationSeconds(hit));
    return {
      start: hit.start,
      end: hit.end,
      rateCentsPerMin: rate.rateCentsPerMin,
      minutes,
      feeCents: minutes * rate.rateCentsPerMin,
    };
  });
}

export function totalFeeCents(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + s.feeCents, 0);
}

/**
 * 网格计时模型（独立对照实现）：
 * 把每段按 1 秒刻度逐格展开，每累计满 60 格（含末尾不足 60 格的一段）计 1 分钟。
 * 与 buildSegments 的公式法（ceil(秒/60)）走完全不同的代码路径，用于交叉核对。
 */
export function gridSegmentFeeCents(
  start: number,
  end: number,
  rateCentsPerMin: number,
): number {
  let minutes = 0;
  let tick = 0;
  for (let t = start; t < end; t++) {
    if (tick === 0) minutes++;
    tick = (tick + 1) % 60;
  }
  return minutes * rateCentsPerMin;
}

/** 网格模型下的整单费用：逐段模拟后求和。 */
export function gridTotalFeeCents(segments: Segment[]): number {
  return segments.reduce(
    (sum, s) => sum + gridSegmentFeeCents(s.start, s.end, s.rateCentsPerMin),
    0,
  );
}
