/** 半开区间 [start, end)，时间为整数秒。 */
export interface Interval {
  start: number;
  end: number;
}

export function assertValidInterval(iv: Interval, what = "interval"): void {
  if (!Number.isInteger(iv.start) || !Number.isInteger(iv.end)) {
    throw new Error(`${what}: 起止必须为整数秒，得到 [${iv.start}, ${iv.end})`);
  }
  if (iv.start > iv.end) {
    throw new Error(`${what}: 起点大于终点 [${iv.start}, ${iv.end})`);
  }
}

/**
 * 上线区间求并集：先按起点排序，重叠或首尾相接（半开区间下相邻）的区间合并。
 * 返回按起点升序、互不相交且不相邻的区间数组。
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .map((iv) => ({ start: iv.start, end: iv.end }))
    .filter((iv) => {
      assertValidInterval(iv, "上线区间");
      return iv.start < iv.end;
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

/** 两个半开区间求交，不相交返回 null。 */
export function intersect(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}
