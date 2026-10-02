import { createHash } from 'node:crypto';

export function canonicalString(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalString).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalString(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function stateHash(state) {
  return sha256Hex(canonicalString(state));
}
