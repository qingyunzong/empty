import { createHash } from 'node:crypto';

// Deterministic JSON serialization: object keys sorted, arrays in order.
export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonical(item)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => JSON.stringify(key) + ':' + canonical(value[key]));
  return '{' + parts.join(',') + '}';
}

export function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Deterministic id ordering: numbers numerically before strings, strings lexicographic.
export function idCompare(a, b) {
  const ta = typeof a;
  const tb = typeof b;
  if (ta === 'number' && tb === 'number') return a - b;
  if (ta !== tb) return ta === 'number' ? -1 : 1;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
