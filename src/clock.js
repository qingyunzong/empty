// Vector-clock utilities for causal ordering of claims.

export function compare(a = {}, b = {}) {
  let le = true;
  let ge = true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key] ?? 0;
    const y = b[key] ?? 0;
    if (x > y) le = false;
    if (x < y) ge = false;
  }
  if (le && ge) return 'equal';
  if (le) return 'before';
  if (ge) return 'after';
  return 'concurrent';
}

export function merge(a = {}, b = {}) {
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) out[key] = Math.max(a[key] ?? 0, b[key] ?? 0);
  return out;
}

export function clocksEqual(a = {}, b = {}) {
  return compare(a, b) === 'equal';
}

export function happensBefore(a = {}, b = {}) {
  return compare(a, b) === 'before';
}
