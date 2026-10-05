/** 半开区间 [start, end)，边界为整数秒。 */
export interface Interval {
  start: number;
  end: number;
}

export function assertValidInterval(iv: Interval): void {
  if (!Number.isInteger(iv.start) || !Number.isInteger(iv.end)) {
    throw new Error(`区间边界必须为整数秒: [${iv.start}, ${iv.end})`);
  }
  if (iv.start >= iv.end) {
    throw new Error(`区间必须满足 start < end: [${iv.start}, ${iv.end})`);
  }
}

export function durationSeconds(iv: Interval): number {
  return iv.end - iv.start;
}

/** 判断两个区间是否重叠或相邻（相邻区间在时间上连续，并集应合并）。 */
function touchesOrOverlaps(a: Interval, b: Interval): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * 求区间并集：先按起点排序，再合并所有重叠或相邻的区间。
 * 返回按起点升序、互不相交（且互不相邻）的区间数组。
 */
export function unionIntervals(intervals: Interval[]): Interval[] {
  for (const iv of intervals) assertValidInterval(iv);
  const sorted = intervals
    .map((iv) => ({ start: iv.start, end: iv.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && touchesOrOverlaps(last, iv)) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

/** 两个区间的交集，不相交时返回 null。 */
export function intersectInterval(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

/** 一组区间与另一组区间的所有交集（要求两边都已按起点升序且互不相交）。 */
export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const hit = intersectInterval(a[i]!, b[j]!);
    if (hit) out.push(hit);
    if (a[i]!.end < b[j]!.end) i++;
    else j++;
  }
  return out;
}

/** 区间集合覆盖的总秒数（要求互不相交）。 */
export function coveredSeconds(intervals: Interval[]): number {
  return intervals.reduce((sum, iv) => sum + durationSeconds(iv), 0);
}
