import { createHash } from 'node:crypto';

// Deterministic canonical serialization: object keys sorted, arrays in order.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function hashValue(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
