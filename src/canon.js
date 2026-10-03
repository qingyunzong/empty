import { createHash } from 'node:crypto';

export function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isNaN(value) ? 'null' : JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function hashRow(row) {
  return sha256(canonical(row));
}
