import { findCycle } from './graph.js';

export const SCALAR_FIELDS = ['ts', 'source', 'type', 'ackBy', 'note', 'deleted'];

export function normalizeEvent(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') errors.push('event must be an object');
  const e = raw ?? {};
  if (typeof e.id !== 'string' || e.id.length === 0) errors.push('id must be a non-empty string');
  if (!Number.isInteger(e.ts)) errors.push(`ts of ${e.id} must be an integer`);
  if (typeof e.source !== 'string') errors.push(`source of ${e.id} must be a string`);
  if (typeof e.type !== 'string') errors.push(`type of ${e.id} must be a string`);
  if (!(typeof e.ackBy === 'string' || e.ackBy === null)) errors.push(`ackBy of ${e.id} must be a string or null`);
  if (typeof e.note !== 'string') errors.push(`note of ${e.id} must be a string`);
  if (typeof e.deleted !== 'boolean') errors.push(`deleted of ${e.id} must be a boolean`);
  if (!Array.isArray(e.dependsOn) || e.dependsOn.some((d) => typeof d !== 'string')) {
    errors.push(`dependsOn of ${e.id} must be an array of strings`);
  }
  if (errors.length) {
    const err = new Error('invalid event: ' + errors.join('; '));
    err.code = 'INVALID_EVENT';
    err.errors = errors;
    throw err;
  }
  const dependsOn = [...new Set(e.dependsOn)].sort();
  return Object.freeze({
    id: e.id,
    ts: e.ts,
    source: e.source,
    type: e.type,
    ackBy: e.ackBy,
    note: e.note,
    deleted: e.deleted,
    dependsOn: Object.freeze(dependsOn),
  });
}

export function normalizeBranch(events) {
  if (!Array.isArray(events)) {
    const err = new Error('branch events must be an array');
    err.code = 'INVALID_BRANCH';
    throw err;
  }
  const map = new Map();
  for (const raw of events) {
    const e = normalizeEvent(raw);
    if (map.has(e.id)) {
      const err = new Error(`duplicate event id ${e.id}`);
      err.code = 'DUPLICATE_ID';
      throw err;
    }
    map.set(e.id, e);
  }
  return map;
}

// Every input branch must have resolvable references and an acyclic
// dependency graph. Deleted events keep metadata and edges.
export function validateBranch(events) {
  const errors = [];
  for (const e of events.values()) {
    for (const dep of e.dependsOn) {
      if (!events.has(dep)) errors.push({ type: 'MISSING_REF', eventId: e.id, dependsOn: dep });
    }
  }
  const cycle = findCycle(events);
  if (cycle) errors.push({ type: 'CYCLE', cycle });
  return { ok: errors.length === 0, errors };
}
