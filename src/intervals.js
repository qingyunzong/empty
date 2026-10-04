// Opaque half-open interval set [start, end). Boundary contact is not an
// overlap; empty intervals (start >= end) carry no points and never overlap.
export class IntervalSet {
  constructor() {
    this.intervals = [];
    this.dirty = false;
  }

  add(start, end) {
    if (!(start < end)) return;
    this.intervals.push([start, end]);
    this.dirty = true;
  }

  normalize() {
    if (!this.dirty) return;
    this.intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const [s, e] of this.intervals) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    this.intervals = merged;
    this.dirty = false;
  }

  overlaps(start, end) {
    if (!(start < end)) return false;
    this.normalize();
    let lo = 0;
    let hi = this.intervals.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.intervals[mid][1] > start) hi = mid;
      else lo = mid + 1;
    }
    return lo < this.intervals.length && this.intervals[lo][0] < end;
  }
}

// Reference algorithm: enumerate every stored interval pairwise.
export function referenceOverlaps(intervals, start, end) {
  if (!(start < end)) return false;
  return intervals.some(([s, e]) => s < e && s < end && start < e);
}
