export const BEFORE = -1;
export const EQUAL = 0;
export const AFTER = 1;
export const CONCURRENT = 2;

export function compare(a = {}, b = {}) {
  let less = false;
  let greater = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key] ?? 0;
    const y = b[key] ?? 0;
    if (x < y) less = true;
    else if (x > y) greater = true;
    if (less && greater) return CONCURRENT;
  }
  if (less) return BEFORE;
  if (greater) return AFTER;
  return EQUAL;
}

export function merge(a = {}, b = {}) {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    out[key] = Math.max(out[key] ?? 0, value);
  }
  return out;
}
