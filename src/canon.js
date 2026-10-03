import { createHash } from 'node:crypto';

// Deterministic JSON serialization: object keys sorted recursively,
// arrays kept in order, no undefined values allowed.
export function canon(value) {
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canon).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
  }
  throw new Error('cannot canonicalize value of type ' + typeof value);
}

export function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export const GENESIS = '0'.repeat(64);
