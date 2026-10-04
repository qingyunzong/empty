// Vector clock primitives.

export function happensBefore(a, b) {
  let strictlyLess = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key] || 0;
    const y = b[key] || 0;
    if (x > y) return false;
    if (x < y) strictlyLess = true;
  }
  return strictlyLess;
}

export function concurrent(a, b) {
  return !happensBefore(a, b) && !happensBefore(b, a);
}

export function mergeClocks(a, b) {
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) out[key] = Math.max(a[key] || 0, b[key] || 0);
  return out;
}
