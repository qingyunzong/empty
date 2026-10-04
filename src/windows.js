// Incremental sliding-window state.
//
// WindowIndex keeps per-observation values sorted by time plus lazily rebuilt
// prefix sums, so range aggregates over any (start, end] / [start, end] are
// O(log n + k) without recomputing the whole series. WindowCache memoizes
// computed window results; correcting an observation invalidates only the
// cached windows whose interval actually contains the corrected timestamp.

export function windowContains(start, end, bounds, t) {
  const leftOk = bounds === 'closed' ? start <= t : start < t;
  return leftOk && t <= end;
}

function lowerBoundTime(entries, t) {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function upperBoundTime(entries, t) {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].t <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export class WindowIndex {
  constructor(entries = []) {
    this.entries = entries; // sorted by (t, k): {t, k, v|null}
    this.dirty = true;
    this.prefixCount = [0];
    this.prefixSum = [0];
  }

  insert(entry) {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const e = this.entries[mid];
      if (e.t < entry.t || (e.t === entry.t && e.k < entry.k)) lo = mid + 1; else hi = mid;
    }
    this.entries.splice(lo, 0, entry);
    this.dirty = true;
  }

  removeByKey(key) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.k !== key);
    if (this.entries.length !== before) this.dirty = true;
  }

  rebuild() {
    const n = this.entries.length;
    this.prefixCount = new Array(n + 1).fill(0);
    this.prefixSum = new Array(n + 1).fill(0);
    for (let i = 0; i < n; i += 1) {
      const v = this.entries[i].v;
      const present = typeof v === 'number' && !Number.isNaN(v);
      this.prefixCount[i + 1] = this.prefixCount[i] + (present ? 1 : 0);
      this.prefixSum[i + 1] = this.prefixSum[i] + (present ? v : 0);
    }
    this.dirty = false;
  }

  stats(start, end, bounds) {
    if (this.dirty) this.rebuild();
    const lo = bounds === 'closed' ? lowerBoundTime(this.entries, start) : upperBoundTime(this.entries, start);
    const hi = upperBoundTime(this.entries, end);
    let min = null;
    let max = null;
    for (let i = lo; i < hi; i += 1) {
      const v = this.entries[i].v;
      if (typeof v !== 'number' || Number.isNaN(v)) continue;
      if (min === null || v < min) min = v;
      if (max === null || v > max) max = v;
    }
    return {
      count: this.prefixCount[hi] - this.prefixCount[lo],
      sum: this.prefixSum[hi] - this.prefixSum[lo],
      min,
      max,
    };
  }
}

export function aggregate(fn, stats) {
  switch (fn) {
    case 'count': return stats.count;
    case 'sum': return stats.count > 0 ? stats.sum : null;
    case 'avg': return stats.count > 0 ? stats.sum / stats.count : null;
    case 'min': return stats.min;
    case 'max': return stats.max;
    default: return null;
  }
}

export class WindowCache {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries)); // key -> {start, end, bounds, result}
  }

  static key(defKey, start, end) {
    return `${defKey}|${start}|${end}`;
  }

  get(defKey, start, end) {
    const hit = this.map.get(WindowCache.key(defKey, start, end));
    return hit === undefined ? undefined : hit.result;
  }

  set(defKey, start, end, bounds, result) {
    this.map.set(WindowCache.key(defKey, start, end), { start, end, bounds, result });
  }

  // Drop only cached windows whose interval contains any corrected timestamp.
  invalidateOverlapping(times) {
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (times.some((t) => windowContains(entry.start, entry.end, entry.bounds, t))) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear() {
    this.map.clear();
  }

  toJSON() {
    return Object.fromEntries(this.map);
  }
}
