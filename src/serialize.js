import { createHash } from 'node:crypto';

// Canonical JSON: object keys sorted recursively, so equal states always
// serialize identically regardless of key insertion order.
export function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stateHash(state) {
  return createHash('sha256').update(canonical(state)).digest('hex');
}
