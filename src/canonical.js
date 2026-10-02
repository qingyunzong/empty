import { createHash } from 'node:crypto';

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashEvent(prevHash, body) {
  return sha256hex(prevHash + canonical(body));
}
