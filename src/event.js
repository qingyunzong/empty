import { ValidationError } from './errors.js';
import { dominates } from './clock.js';

export const KINDS = new Set(['join', 'leave', 'interlock', 'bypass', 'unbypass', 'reset']);
export const DATA_KINDS = new Set(['interlock', 'bypass', 'unbypass', 'reset']);

export function isDataKind(kind) {
  return DATA_KINDS.has(kind);
}

// Structural validation only; semantic checks (membership, fencing) live in replay.js.
// `ts` is accepted as informational metadata but is NEVER used for ordering or arbitration.
export function validateEvent(e) {
  const bad = (msg) => {
    throw new ValidationError(`invalid event${e && e.id ? ` ${JSON.stringify(e.id)}` : ''}: ${msg}`, e && e.id);
  };
  if (e === null || typeof e !== 'object' || Array.isArray(e)) bad('must be an object');
  if (typeof e.id !== 'string' || e.id.length === 0) bad('id must be a non-empty string');
  if (typeof e.member !== 'string' || e.member.length === 0) bad('member must be a non-empty string');
  if (!Number.isInteger(e.epoch) || e.epoch < 1) bad('epoch must be an integer >= 1');
  if (!Number.isInteger(e.seq) || e.seq < 1) bad('seq must be an integer >= 1');
  if (!KINDS.has(e.kind)) bad(`kind must be one of ${[...KINDS].join(', ')}`);
  if (DATA_KINDS.has(e.kind) && (typeof e.valve !== 'string' || e.valve.length === 0)) {
    bad(`kind ${e.kind} requires a non-empty valve`);
  }
  if (e.clock === null || typeof e.clock !== 'object' || Array.isArray(e.clock)) bad('clock must be an object');
  for (const [k, v] of Object.entries(e.clock)) {
    if (!Number.isInteger(v) || v < 1) bad(`clock[${JSON.stringify(k)}] must be an integer >= 1`);
  }
  if (e.clock[e.member] !== e.seq) bad('clock[member] must equal seq');
  if (e.ts !== undefined && (typeof e.ts !== 'number' || !Number.isFinite(e.ts))) bad('ts must be a finite number');
  return e;
}

// Deterministic total order over an event SET:
//   1. causal order (vector-clock happens-before) is always respected;
//   2. concurrent events are ordered by (epoch, id) ascending, so the event with
//      the higher member epoch - then higher id - is applied LAST and wins conflicts.
// Wall-clock timestamps are never consulted, so ties can never resolve randomly.
// The result depends only on the set of events, not on their input order.
export function canonicalOrder(events) {
  const predCount = new Map();
  const successors = new Map();
  for (const e of events) {
    predCount.set(e.id, 0);
    successors.set(e.id, []);
  }
  for (const e of events) {
    for (const f of events) {
      if (e === f) continue;
      if (dominates(e.clock, f.clock)) {
        predCount.set(e.id, predCount.get(e.id) + 1);
        successors.get(f.id).push(e);
      }
    }
  }
  const less = (a, b) => (a.epoch !== b.epoch ? a.epoch - b.epoch : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const available = events.filter((e) => predCount.get(e.id) === 0).sort(less);
  const out = [];
  while (available.length > 0) {
    const next = available.shift();
    out.push(next);
    for (const s of successors.get(next.id)) {
      const c = predCount.get(s.id) - 1;
      predCount.set(s.id, c);
      if (c === 0) {
        let i = available.length;
        while (i > 0 && less(available[i - 1], s) > 0) i--;
        available.splice(i, 0, s);
      }
    }
  }
  if (out.length !== events.length) {
    throw new ValidationError('events contain a causality cycle');
  }
  return out;
}

export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const body = Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`)
    .join(',');
  return `{${body}}`;
}
