export interface Interval {
  start: number;
  end: number;
}

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((iv) => iv.end > iv.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

export function subtractIntervals(base: Interval[], cuts: Interval[]): Interval[] {
  const blocked = mergeIntervals(cuts);
  const result: Interval[] = [];
  for (const iv of mergeIntervals(base)) {
    let cursor = iv.start;
    for (const cut of blocked) {
      if (cut.end <= cursor) continue;
      if (cut.start >= iv.end) break;
      if (cut.start > cursor) {
        result.push({ start: cursor, end: Math.min(cut.start, iv.end) });
      }
      cursor = Math.max(cursor, cut.end);
      if (cursor >= iv.end) break;
    }
    if (cursor < iv.end) result.push({ start: cursor, end: iv.end });
  }
  return result;
}

export function totalLength(intervals: Interval[]): number {
  return intervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
}
