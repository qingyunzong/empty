import { createHash } from 'node:crypto';

export function canon(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number not allowed');
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
  }
  throw new Error(`cannot canonicalize ${t}`);
}

export function sha256hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function eventIdOf(event) {
  return sha256hex(canon(event));
}
