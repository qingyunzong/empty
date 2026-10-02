// Vector-clock utilities. No physical time is ever used for ordering decisions.

export function compareClocks(a, b) {
  let less = false;
  let greater = false;
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const d = (a?.[k] || 0) - (b?.[k] || 0);
    if (d < 0) less = true;
    else if (d > 0) greater = true;
  }
  if (less && greater) return 'concurrent';
  if (greater) return 'gt';
  if (less) return 'lt';
  return 'eq';
}

export function isConcurrent(a, b) {
  return compareClocks(a, b) === 'concurrent';
}

// dominates(a, b) === every component of a is >= the corresponding component of b.
export function dominates(a, b) {
  const r = compareClocks(a, b);
  return r === 'gt' || r === 'eq';
}

export function mergeClock(a, b) {
  const out = { ...(a || {}) };
  for (const k of Object.keys(b || {})) out[k] = Math.max(out[k] || 0, b[k]);
  return out;
}
