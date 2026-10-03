// Vector clock primitives. A vector clock maps nodeId -> logical sequence.

// Compare two vector clocks.
// Returns 'lt' (a happened-before b), 'gt', 'eq', or 'concurrent'.
export function compareVclock(a = {}, b = {}) {
  let aLess = false;
  let bLess = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key] || 0;
    const y = b[key] || 0;
    if (x < y) aLess = true;
    else if (x > y) bLess = true;
  }
  if (aLess && bLess) return 'concurrent';
  if (aLess) return 'lt';
  if (bLess) return 'gt';
  return 'eq';
}

// Two histories are concurrent iff neither dominates the other.
export function isConcurrent(a = {}, b = {}) {
  return compareVclock(a, b) === 'concurrent';
}

// a causally covers b (a >= b componentwise).
export function dominates(a = {}, b = {}) {
  const rel = compareVclock(a, b);
  return rel === 'gt' || rel === 'eq';
}

// Componentwise max; commutative, associative, idempotent.
export function mergeVclock(...vclocks) {
  const out = {};
  for (const v of vclocks) {
    if (!v) continue;
    for (const [key, n] of Object.entries(v)) {
      if (typeof n === 'number' && (out[key] || 0) < n) out[key] = n;
    }
  }
  return out;
}
