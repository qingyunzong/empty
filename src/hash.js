import { createHash } from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

export function hashState(state) {
  return createHash('sha256').update(canonical(state), 'utf8').digest('hex');
}
