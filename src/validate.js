import { OeeError, ERR } from './errors.js';

export const TYPES = Object.freeze(['run', 'idle', 'fault', 'changeover', 'maintenance']);

// Higher priority wins when intervals overlap.
export const PRIORITY = Object.freeze({
  fault: 50,
  maintenance: 40,
  changeover: 30,
  idle: 20,
  run: 10,
  uncovered: 0,
});

export const DEFAULT_PARAMS = Object.freeze({
  maxSkewMs: 300_000,               // tolerated out-of-orderness / clock rollback
  minSegmentMs: 0,                  // segments shorter than this are absorbed into a neighbor
  changeoverPlannedBudgetMs: 1_800_000, // changeover <= budget is planned, else unplanned
  performance: 1,
  quality: 1,
});

export function validateParams(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OeeError(ERR.SCHEMA, 'params must be an object');
  }
  const params = { ...DEFAULT_PARAMS, ...raw };
  for (const key of ['maxSkewMs', 'minSegmentMs', 'changeoverPlannedBudgetMs']) {
    if (!Number.isFinite(params[key]) || params[key] < 0) {
      throw new OeeError(ERR.SCHEMA, `params.${key} must be a finite number >= 0`);
    }
  }
  for (const key of ['performance', 'quality']) {
    if (!Number.isFinite(params[key]) || params[key] < 0 || params[key] > 1) {
      throw new OeeError(ERR.SCHEMA, `params.${key} must be in [0, 1]`);
    }
  }
  return params;
}

// Validates events, collapses exact duplicates (same id + same payload),
// rejects same id with different payload as ERR_CONFLICT.
export function validateEvents(raw) {
  if (!Array.isArray(raw)) {
    throw new OeeError(ERR.SCHEMA, 'events must be an array');
  }
  const seen = new Map();
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const ev = raw[i];
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
      throw new OeeError(ERR.SCHEMA, `events[${i}] must be an object`);
    }
    if (ev.id === undefined || ev.id === null) {
      throw new OeeError(ERR.SCHEMA, `events[${i}].id is required`);
    }
    if (!TYPES.includes(ev.type)) {
      throw new OeeError(ERR.SCHEMA, `events[${i}].type must be one of ${TYPES.join('|')}`, { got: ev.type });
    }
    if (!Number.isFinite(ev.start) || !Number.isFinite(ev.end)) {
      throw new OeeError(ERR.SCHEMA, `events[${i}].start/end must be finite numbers`);
    }
    if (ev.end < ev.start) {
      throw new OeeError(ERR.SCHEMA, `events[${i}].end < start`, { id: ev.id });
    }
    const key = String(ev.id);
    const norm = { id: ev.id, type: ev.type, start: ev.start, end: ev.end };
    if (seen.has(key)) {
      const prev = seen.get(key);
      if (prev.type !== norm.type || prev.start !== norm.start || prev.end !== norm.end) {
        throw new OeeError(ERR.CONFLICT, `duplicate id "${key}" with conflicting payload`, {
          id: ev.id,
          first: prev,
          second: norm,
        });
      }
      continue; // exact duplicate: dedup
    }
    seen.set(key, norm);
    out.push(norm);
  }
  return out;
}

// Arrival order = array order. A start earlier than maxStart - maxSkewMs is a clock rollback.
export function checkClock(events, params) {
  let maxStart = -Infinity;
  for (const ev of events) {
    if (ev.start < maxStart - params.maxSkewMs) {
      throw new OeeError(
        ERR.CLOCK,
        `clock rollback: event "${ev.id}" starts at ${ev.start}, ${maxStart - ev.start}ms before max seen ${maxStart}, exceeds maxSkewMs ${params.maxSkewMs}`,
        { id: ev.id, start: ev.start, maxStart, maxSkewMs: params.maxSkewMs },
      );
    }
    if (ev.start > maxStart) maxStart = ev.start;
  }
}
