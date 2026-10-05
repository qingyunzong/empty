// Vector-clock causality primitives. Clocks are plain objects: member -> seq (int >= 1).

export function clockLeq(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((a[k] ?? 0) > (b[k] ?? 0)) return false;
  }
  return true;
}

export function clockEqual(a, b) {
  return clockLeq(a, b) && clockLeq(b, a);
}

// a strictly dominates b: a happens-after b.
export function dominates(a, b) {
  return clockLeq(b, a) && !clockEqual(a, b);
}

// -1: a < b, 0: equal, 1: a > b, 2: concurrent.
export function compareCausality(a, b) {
  const ab = clockLeq(a, b);
  const ba = clockLeq(b, a);
  if (ab && ba) return 0;
  if (ab) return -1;
  if (ba) return 1;
  return 2;
}

export function clockMerge(a, b) {
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) out[k] = Math.max(a[k] ?? 0, b[k] ?? 0);
  return out;
}
