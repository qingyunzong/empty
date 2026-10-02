import { createHash } from 'node:crypto';

// Deterministic JSON: object keys sorted, arrays in order, no whitespace.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashValue(value) {
  return sha256hex(canonicalJson(value));
}
