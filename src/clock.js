export function leq(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) if ((a?.[k] || 0) > (b?.[k] || 0)) return false;
  return true;
}

export function concurrent(a, b) {
  return !leq(a, b) && !leq(b, a);
}

export function mergeClocks(a, b) {
  const r = { ...(a || {}) };
  for (const k of Object.keys(b || {})) r[k] = Math.max(r[k] || 0, b[k]);
  return r;
}
