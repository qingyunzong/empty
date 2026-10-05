/** Interval algebra over inclusive integer ranges. */

export type Interval = [number, number];

/** Sort and merge overlapping or adjacent intervals. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.map(([a, b]) => [a, b] as Interval).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) {
      if (b > last[1]) last[1] = b;
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

/** Compute base \ cut; both inputs must already be merged. */
export function subtractIntervals(base: Interval[], cut: Interval[]): Interval[] {
  const out: Interval[] = [];
  let j = 0;
  for (const [a0, b0] of base) {
    let cur = a0;
    while (j < cut.length && cut[j]![1] < cur) j++;
    let k = j;
    while (k < cut.length && cut[k]![0] <= b0) {
      const [ca, cb] = cut[k]!;
      if (ca > cur) out.push([cur, Math.min(b0, ca - 1)]);
      if (cb >= b0) { cur = b0 + 1; break; }
      cur = cb + 1;
      k++;
    }
    if (cur <= b0) out.push([cur, b0]);
  }
  return out;
}

/**
 * Gaps the receiver still needs: everything coverable by the available
 * packages minus what the receiver already has.
 */
export function computeGaps(existing: Interval[], covers: Interval[]): Interval[] {
  const universe = mergeIntervals(covers);
  return subtractIntervals(universe, mergeIntervals(existing));
}
