import { createHash } from 'node:crypto';

// Canonical serialization: object keys sorted, so hashing is structure-based,
// not key-order-based.
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

export function stateHash(state) {
  return createHash('sha256').update(stableStringify(state)).digest('hex');
}
