import { createHash } from 'node:crypto';

export const ZERO_HASH = '0'.repeat(64);

export function sha256hex(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

// Deterministic JSON encoding: object keys sorted recursively, no whitespace.
export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

// Hash of a block's semantic content (excludes the stored "hash" field itself).
export function computeBlockHash(block) {
  const { index, epoch, prev, kind, payload } = block;
  return sha256hex(canonical({ index, epoch, prev, kind, payload }));
}
