import { createHash } from 'node:crypto';

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

export function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function leafDigest(canonicalEvent) {
  return sha256hex(`settle:leaf:v1:${canonicalEvent}`);
}

export function historyHashOf(digests) {
  const h = createHash('sha256');
  h.update('settle:history:v1\n');
  for (const d of digests) {
    h.update(d);
    h.update('\n');
  }
  return h.digest('hex');
}
