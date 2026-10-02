import { createHash } from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function proofOf(state) {
  const { config, clock, generation, batches, segments, maintenance, imaged, groups } = state;
  return createHash('sha256')
    .update(canonical({ config, clock, generation, batches, segments, maintenance, imaged, groups }))
    .digest('hex');
}

export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}
