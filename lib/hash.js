import { createHash } from 'node:crypto';

// Deterministic canonical JSON: object keys sorted recursively.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function sha256hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

export function hashObject(obj) {
  return sha256hex(canonical(obj));
}
