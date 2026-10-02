import { createHash } from 'node:crypto';

// Deterministic JSON serialization: object keys sorted, no whitespace.
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

export function sha256hex(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
