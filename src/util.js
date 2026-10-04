import { createHash } from 'node:crypto';

export function canonicalize(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  switch (typeof value) {
    case 'number': {
      if (!Number.isFinite(value)) throw new TypeError('cannot canonicalize non-finite number');
      return Object.is(value, -0) ? '0' : String(value);
    }
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return String(value);
    case 'object': {
      const keys = Object.keys(value).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`cannot canonicalize type ${typeof value}`);
  }
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
