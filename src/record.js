import { createHash } from 'node:crypto';

export const RECORD_TYPES = new Set(['step', 'deviation', 'tombstone', 'join', 'exit']);

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashRecord(record) {
  const { hash, ...body } = record;
  return sha256hex(canonical(body));
}

export function makeRecord({ type, site, gen, vc, prev, payload }) {
  if (!RECORD_TYPES.has(type)) throw new Error(`unknown record type: ${type}`);
  if (typeof site !== 'string' || site.length === 0) throw new Error('site is required');
  if (!Number.isInteger(gen) || gen < 1) throw new Error('gen must be a positive integer');
  const record = {
    v: 1,
    type,
    site,
    gen,
    vc: { ...vc },
    prev: prev ?? null,
    payload: payload ?? {},
  };
  record.hash = hashRecord(record);
  return record;
}
