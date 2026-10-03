import { createHash } from 'node:crypto';

// Deterministic canonical serialization: object keys sorted, bigints tagged.
export function canonical(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number' || t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') return JSON.stringify(`${value.toString()}n`);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`cannot canonicalize value of type ${t}`);
}

export function sha256hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function stateHash(value) {
  return sha256hex(canonical(value));
}
