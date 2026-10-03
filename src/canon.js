import { createHash } from 'node:crypto';

// Canonical JSON: object keys sorted, arrays in given order, no whitespace.
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

// Normalize one allocation record to exactly the four scheduling fields.
export function normalizeAlloc(a) {
  return { machine: a.machine, day: a.day, material: a.material, amount: a.amount };
}

export function compareAlloc(a, b) {
  const sa = canonicalize(normalizeAlloc(a));
  const sb = canonicalize(normalizeAlloc(b));
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// A plan is a list of {machine, day, material, amount} allocations.
// Its canonical form sorts allocations deterministically.
export function canonicalPlan(plan) {
  const allocs = plan.map(normalizeAlloc).sort(compareAlloc);
  return canonicalize(allocs);
}

export function comparePlan(pa, pb) {
  const a = typeof pa === 'string' ? pa : canonicalPlan(pa);
  const b = typeof pb === 'string' ? pb : canonicalPlan(pb);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function hashPlan(plan) {
  const canonical = typeof plan === 'string' ? plan : canonicalPlan(plan);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
