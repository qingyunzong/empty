import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function hashEvent(event) {
  return sha256hex(canonical({
    seq: event.seq,
    type: event.type,
    payload: event.payload,
    prev: event.prev,
  }));
}
