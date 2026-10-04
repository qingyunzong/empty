import { createHash } from 'node:crypto';

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function hashEvent(event) {
  const { hash, ...rest } = event;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

export function verifyEvent(event) {
  return typeof event.hash === 'string' && event.hash === hashEvent(event);
}
