// Version-vector helpers. compare(a, b) returns:
//   -1 a strictly dominated by b, 0 equal, 1 a strictly dominates b, 2 concurrent.
export function compare(a, b) {
  let less = false;
  let greater = false;
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const x = (a && a[k]) || 0;
    const y = (b && b[k]) || 0;
    if (x < y) less = true;
    else if (x > y) greater = true;
  }
  if (less && greater) return 2;
  if (less) return -1;
  if (greater) return 1;
  return 0;
}

export function merge(a, b) {
  const out = { ...(a || {}) };
  for (const k of Object.keys(b || {})) {
    out[k] = Math.max(out[k] || 0, b[k]);
  }
  return out;
}
