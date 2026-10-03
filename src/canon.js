import { createHash } from 'node:crypto';

// Deterministic JSON: object keys sorted (code-unit order), arrays kept in
// order, no undefined/functions. Same logical value -> same string, always.
export function canon(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canon).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
  }
  throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
}

export function canonPretty(value, indent = 2) {
  return JSON.stringify(JSON.parse(canon(value)), null, indent);
}

export function hashObject(value) {
  return createHash('sha256').update(canon(value), 'utf8').digest('hex');
}
