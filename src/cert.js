import { logHash } from './log.js';
import { stateHashOf } from './store.js';

export function certificate({ plan, entries, dyn, pending, clock, times }) {
  return {
    format: 'plan-sync-cert/1',
    clock,
    entries: entries.length,
    logHash: logHash(entries),
    stateHash: stateHashOf(dyn),
    cost: times.cost,
    budget: plan.budget,
    tardiness: times.tardiness,
    pending,
    schedule: dyn.order,
    start: times.start,
    end: times.end,
  };
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}

export function prettyCanonical(v) {
  return JSON.stringify(sortKeys(v), null, 2) + '\n';
}
