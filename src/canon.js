import { createHash } from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function digest(value) {
  return sha256(canonical(value));
}
