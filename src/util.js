import { createHash } from 'node:crypto';

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function deepEqual(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return canonical(a) === canonical(b);
}

export function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

export function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
