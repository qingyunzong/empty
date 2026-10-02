import { createHash } from 'node:crypto';

// Canonical (key-sorted) JSON so hashes are stable across processes.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export function makeEvent({ site, seq, vc, kind, op, wo = null, alarm = null, actor, team = null, interlock = false, ts }) {
  const body = { site, seq, vc, kind, op, wo, alarm, actor, team, interlock, ts };
  return { id: sha256(canonical(body)).slice(0, 24), ...body };
}

export const keyOf = (e) => `${e.site}:${e.seq}`;

// Deterministic total order used as tie-break between causally-ready events.
export function cmpEvent(a, b) {
  if (a.site !== b.site) return a.site < b.site ? -1 : 1;
  return a.seq - b.seq;
}
