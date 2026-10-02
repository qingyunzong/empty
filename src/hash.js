import { createHash } from 'node:crypto';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function hashCanonical(value) {
  return sha256(canonical(value));
}
