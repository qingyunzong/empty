import type { Interval } from "./types.js";

/** Sort intervals and merge overlapping/touching ones into a disjoint list. */
export function normalize(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((iv) => iv.start < iv.end)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  }
  return out;
}

/** range minus covered: the gap intervals the receiver still needs. */
export function subtract(range: Interval, covered: Interval[]): Interval[] {
  const gaps: Interval[] = [];
  let cursor = range.start;
  for (const iv of normalize(covered)) {
    const s = Math.max(iv.start, range.start);
    const e = Math.min(iv.end, range.end);
    if (e <= cursor) continue;
    if (s > cursor) gaps.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  if (cursor < range.end) gaps.push({ start: cursor, end: range.end });
  return gaps;
}

/** Intersect two disjoint sorted interval lists. */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!;
    const y = b[j]!;
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (start < end) out.push({ start, end });
    if (x.end < y.end) i++;
    else j++;
  }
  return out;
}

export function totalLength(intervals: Interval[]): number {
  return intervals.reduce((acc, iv) => acc + (iv.end - iv.start), 0);
}
