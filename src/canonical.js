import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization: object keys sorted recursively,
 * no whitespace. Used for equality checks and hashing.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashValue(value) {
  return sha256Hex(canonicalize(value));
}

/** Deep equality via canonical form (key-order insensitive). */
export function deepEqual(a, b) {
  return canonicalize(a) === canonicalize(b);
}
