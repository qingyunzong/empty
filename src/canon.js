import { createHash } from 'node:crypto';

// Canonical serialization: object keys sorted recursively, arrays keep order.
// Callers sort arrays themselves where order should not matter.
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

export function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
