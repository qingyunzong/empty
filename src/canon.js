import { createHash } from 'node:crypto';

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function canonicalBatches(batches) {
  return Object.values(batches)
    .map((b) => ({
      id: b.id,
      weight: b.weight,
      qc: b.qc,
      parents: [...b.parents].sort(byId).map((p) => ({ id: p.id, amount: p.amount })),
      children: [...b.children].sort(byId).map((c) => ({ id: c.id, amount: c.amount })),
    }))
    .sort(byId);
}
