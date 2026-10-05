/** 半开区间 [start, end) 的规范化集合操作。所有操作返回新的规范化（有序、不重叠、不相邻）数组。 */

export interface Interval {
  readonly start: number;
  readonly end: number;
}

export function assertValidInterval(iv: Interval): void {
  if (!Number.isFinite(iv.start) || !Number.isFinite(iv.end)) {
    throw new Error(`非法区间端点: [${iv.start}, ${iv.end})`);
  }
  if (iv.start >= iv.end) {
    throw new Error(`半开区间要求 start < end，得到 [${iv.start}, ${iv.end})`);
  }
}

/** 排序并合并重叠/相邻区间。 */
export function normalize(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .map((iv) => ({ start: iv.start, end: iv.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const iv of sorted) {
    assertValidInterval(iv);
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) {
        out[out.length - 1] = { start: last.start, end: iv.end };
      }
    } else {
      out.push(iv);
    }
  }
  return out;
}

/** 集合并：在集合中加入一个区间。 */
export function addInterval(set: readonly Interval[], iv: Interval): Interval[] {
  assertValidInterval(iv);
  return normalize([...set, iv]);
}

/** 集合差：从集合中删去一个区间（可能切分已有区间）。 */
export function removeInterval(set: readonly Interval[], iv: Interval): Interval[] {
  assertValidInterval(iv);
  const out: Interval[] = [];
  for (const cur of set) {
    if (cur.end <= iv.start || cur.start >= iv.end) {
      out.push(cur);
      continue;
    }
    if (cur.start < iv.start) out.push({ start: cur.start, end: iv.start });
    if (cur.end > iv.end) out.push({ start: iv.end, end: cur.end });
  }
  return out;
}

/** 集合交。 */
export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
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

/** 区间集合是否覆盖时刻 t（半开：start <= t < end）。 */
export function covers(set: readonly Interval[], t: number): boolean {
  for (const iv of set) {
    if (iv.start <= t && t < iv.end) return true;
    if (iv.start > t) break;
  }
  return false;
}
