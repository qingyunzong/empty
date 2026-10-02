import { createHash } from 'node:crypto';

export const GENESIS = '0'.repeat(64);

// Deterministic JSON: object keys sorted, so hashing is order-independent.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Hash chain: each event commits to its predecessor, so the head hash is a
// certificate for the whole stream. `record` must NOT contain `hash`.
export function eventHash(prevHash, record) {
  return sha256hex(`${prevHash}\n${canonical(record)}`);
}
