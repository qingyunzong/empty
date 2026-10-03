// Half-open interval sets over the number line: [start, end).
import { intervalError } from './errors.js';

export function validateInterval(interval) {
  if (!Array.isArray(interval) || interval.length !== 2) {
    throw intervalError('interval must be a [start, end] pair', { interval });
  }
  const [start, end] = interval;
  if (typeof start !== 'number' || typeof end !== 'number'
      || !Number.isFinite(start) || !Number.isFinite(end)) {
    throw intervalError('interval endpoints must be finite numbers', { interval });
  }
  if (!(start < end)) {
    throw intervalError('empty or inverted interval: require start < end', { interval });
  }
  return [start, end];
}

// Sort and merge overlapping or touching half-open intervals.
// [0,5) and [5,9) do not overlap, but their union is contiguous, so
// normalization folds them into [0,9).
export function normalize(intervals) {
  const sorted = intervals.map(validateInterval)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

export function union(a, b) {
  return normalize([...a, ...b]);
}

export function intersect(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i][0], right[j][0]);
    const end = Math.min(left[i][1], right[j][1]);
    if (start < end) out.push([start, end]);
    if (left[i][1] < right[j][1]) i += 1; else j += 1;
  }
  return out;
}

export function difference(a, b) {
  const sub = normalize(b);
  const out = [];
  for (const [start, end] of normalize(a)) {
    let cursor = start;
    for (const [s, e] of sub) {
      if (e <= cursor) continue;
      if (s >= end) break;
      if (s > cursor) out.push([cursor, Math.min(s, end)]);
      cursor = Math.max(cursor, e);
      if (cursor >= end) break;
    }
    if (cursor < end) out.push([cursor, end]);
  }
  return out;
}

// Binary search membership of a point in a normalized set.
export function contains(intervals, point) {
  if (typeof point !== 'number' || !Number.isFinite(point)) {
    throw intervalError('query point must be a finite number', { point });
  }
  const set = normalize(intervals);
  let lo = 0;
  let hi = set.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = set[mid];
    if (point < s) hi = mid - 1;
    else if (point >= e) lo = mid + 1;
    else return true;
  }
  return false;
}

// Holes of the set inside [lo, hi).
export function gaps(intervals, [lo, hi]) {
  if (!(typeof lo === 'number' && typeof hi === 'number' && lo < hi)) {
    throw intervalError('gap bound must be [lo, hi] with lo < hi', { bound: [lo, hi] });
  }
  const out = [];
  let cursor = lo;
  for (const [s, e] of normalize(intervals)) {
    if (e <= lo || s >= hi) continue;
    if (s > cursor) out.push([cursor, Math.min(s, hi)]);
    cursor = Math.max(cursor, e);
    if (cursor >= hi) break;
  }
  if (cursor < hi) out.push([cursor, hi]);
  return out;
}

// Genuine overlaps (non-empty intersection) between raw input intervals.
// Adjacent pairs like [0,5) and [5,9) are NOT reported.
export function overlapReport(intervals) {
  const tagged = intervals
    .map((interval, index) => ({ interval: validateInterval(interval), index }))
    .sort((a, b) => a.interval[0] - b.interval[0] || a.interval[1] - b.interval[1]);
  const active = [];
  const pairs = [];
  for (const current of tagged) {
    for (let k = active.length - 1; k >= 0; k -= 1) {
      if (active[k].interval[1] <= current.interval[0]) active.splice(k, 1);
    }
    for (const other of active) {
      const start = Math.max(other.interval[0], current.interval[0]);
      const end = Math.min(other.interval[1], current.interval[1]);
      if (start < end) {
        pairs.push({ a: other.index, b: current.index, intersection: [start, end] });
      }
    }
    active.push(current);
  }
  return pairs;
}
