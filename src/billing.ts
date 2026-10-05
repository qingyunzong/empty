import { Interval, intersect, mergeIntervals } from "./intervals.js";

/** 费率区间：[start, end) 内每分钟 ratePerMinuteCents 分。 */
export interface RateInterval extends Interval {
  ratePerMinuteCents: number;
}

/** 计费段：合并后上线区间与费率区间的一段交集。 */
export interface BillSegment {
  index: number;
  start: number;
  end: number;
  seconds: number;
  /** 每段向上取整的计费分钟数。 */
  billedMinutes: number;
  ratePerMinuteCents: number;
  feeCents: number;
  /** 来源：合并后上线区间下标。 */
  sourceOnlineIndex: number;
  /** 来源：输入费率区间下标。 */
  sourceRateIndex: number;
}

export interface SegmentBill {
  mergedOnline: Interval[];
  segments: BillSegment[];
  totalFeeCents: number;
}

export const SECONDS_PER_MINUTE = 60;

export function ceilMinutes(seconds: number): number {
  return Math.ceil(seconds / SECONDS_PER_MINUTE);
}

function assertValidRates(rates: readonly RateInterval[]): void {
  rates.forEach((r, i) => {
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start >= r.end) {
      throw new Error(`费率区间[${i}]非法：[${r.start}, ${r.end})`);
    }
    if (!Number.isInteger(r.ratePerMinuteCents) || r.ratePerMinuteCents < 0) {
      throw new Error(`费率区间[${i}]费率非法：${r.ratePerMinuteCents}`);
    }
  });
  const sorted = [...rates].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.start < prev.end) {
      throw new Error(`费率区间重叠：[${prev.start}, ${prev.end}) 与 [${cur.start}, ${cur.end})`);
    }
  }
}

/**
 * 分段计费模型：上线区间先求并集，再与费率区间逐段求交；
 * 每段秒数向上计分钟，乘费率得费用。
 */
export function billBySegments(
  online: readonly Interval[],
  rates: readonly RateInterval[],
): SegmentBill {
  assertValidRates(rates);
  const mergedOnline = mergeIntervals(online);
  const segments: BillSegment[] = [];
  mergedOnline.forEach((on, sourceOnlineIndex) => {
    rates.forEach((rate, sourceRateIndex) => {
      const hit = intersect(on, rate);
      if (!hit) return;
      const seconds = hit.end - hit.start;
      const billedMinutes = ceilMinutes(seconds);
      segments.push({
        index: segments.length,
        start: hit.start,
        end: hit.end,
        seconds,
        billedMinutes,
        ratePerMinuteCents: rate.ratePerMinuteCents,
        feeCents: billedMinutes * rate.ratePerMinuteCents,
        sourceOnlineIndex,
        sourceRateIndex,
      });
    });
  });
  const totalFeeCents = segments.reduce((sum, s) => sum + s.feeCents, 0);
  return { mergedOnline, segments, totalFeeCents };
}

/** 网格模型的一段：某合并上线区间与某费率区间的交集，按 60 秒网格计分钟。 */
export interface GridPiece {
  start: number;
  end: number;
  seconds: number;
  /** 覆盖到的 60 秒网格数（碰到的每个网格计 1 分钟）。 */
  gridMinutes: number;
  ratePerMinuteCents: number;
  feeCents: number;
  sourceOnlineIndex: number;
  sourceRateIndex: number;
}

export interface GridBill {
  pieces: GridPiece[];
  totalFeeCents: number;
}

/** [s, e) 覆盖的 60 秒网格 [60k, 60k+60) 数量。 */
export function gridMinutes(start: number, end: number): number {
  if (end <= start) return 0;
  return Math.floor((end - 1) / SECONDS_PER_MINUTE) - Math.floor(start / SECONDS_PER_MINUTE) + 1;
}

/**
 * 网格计时模型：时间轴按 60 秒网格切分，上线时间碰到的每个网格计 1 分钟。
 * 用作分段模型的独立对照。
 */
export function billByGrid(
  online: readonly Interval[],
  rates: readonly RateInterval[],
): GridBill {
  assertValidRates(rates);
  const mergedOnline = mergeIntervals(online);
  const pieces: GridPiece[] = [];
  mergedOnline.forEach((on, sourceOnlineIndex) => {
    rates.forEach((rate, sourceRateIndex) => {
      const hit = intersect(on, rate);
      if (!hit) return;
      const minutes = gridMinutes(hit.start, hit.end);
      pieces.push({
        start: hit.start,
        end: hit.end,
        seconds: hit.end - hit.start,
        gridMinutes: minutes,
        ratePerMinuteCents: rate.ratePerMinuteCents,
        feeCents: minutes * rate.ratePerMinuteCents,
        sourceOnlineIndex,
        sourceRateIndex,
      });
    });
  });
  const totalFeeCents = pieces.reduce((sum, p) => sum + p.feeCents, 0);
  return { pieces, totalFeeCents };
}

export interface ModelComparison {
  segmentTotalCents: number;
  gridTotalCents: number;
  /** 分段模型减网格模型的差额（正数表示分段模型多计）。 */
  diffCents: number;
  equal: boolean;
}

/** 分段模型与网格模型对照。 */
export function compareWithGrid(seg: SegmentBill, grid: GridBill): ModelComparison {
  const diffCents = seg.totalFeeCents - grid.totalFeeCents;
  return {
    segmentTotalCents: seg.totalFeeCents,
    gridTotalCents: grid.totalFeeCents,
    diffCents,
    equal: diffCents === 0,
  };
}
