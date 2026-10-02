'use strict';

// Opaque interval sets over half-open [start, end) pairs of epoch milliseconds.
// Boundary touching does NOT count as overlap; zero-length intervals are empty
// and therefore never overlap anything.

function pairOverlaps(a, b) {
  const [s1, e1] = a;
  const [s2, e2] = b;
  return s1 < e1 && s2 < e2 && s1 < e2 && s2 < e1;
}

// Sort and merge strictly overlapping intervals. Merely touching intervals
// ([a,b) and [b,c)) are kept separate to preserve the touching != overlap
// distinction; zero-length intervals are dropped (they are empty sets).
function normalize(intervals) {
  const sorted = intervals
    .filter(([s, e]) => s < e)
    .map(([s, e]) => [s, e])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s < last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

// Fast path: query against a normalized set.
function setOverlaps(normalizedSet, interval) {
  for (const iv of normalizedSet) {
    if (iv[0] >= interval[1]) break;
    if (pairOverlaps(iv, interval)) return true;
  }
  return false;
}

// Reference algorithm: enumerate every candidate defect interval naively,
// no normalization, no early-exit ordering assumptions.
function referenceOverlaps(defects, interval) {
  for (const d of defects) {
    if (pairOverlaps(d, interval)) return true;
  }
  return false;
}

module.exports = { pairOverlaps, normalize, setOverlaps, referenceOverlaps };
