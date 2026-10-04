'use strict';

const STATES = Object.freeze(['RUN', 'IDLE', 'FAIL', 'MAINT']);
const STATE_SET = new Set(STATES);

class OeeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OeeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function parseTime(value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  throw new OeeError(
    'INVALID_TIME',
    `invalid time for ${field}: ${JSON.stringify(value)}`,
    { field, value }
  );
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function normalizeInterval(raw, fallbackId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OeeError('INVALID_INTERVAL', 'interval must be an object', { value: raw });
  }
  const device = raw.device;
  if (typeof device !== 'string' || device.length === 0) {
    throw new OeeError('INVALID_INTERVAL', 'interval.device must be a non-empty string', { value: raw });
  }
  const state = raw.state;
  if (!STATE_SET.has(state)) {
    throw new OeeError('UNKNOWN_STATE', `unknown state: ${JSON.stringify(state)}`, {
      state,
      allowed: STATES,
    });
  }
  const start = parseTime(raw.start, 'start');
  const end = parseTime(raw.end, 'end');
  if (!(end > start)) {
    throw new OeeError(
      'BACKWARD_CLOCK',
      `interval end must be strictly after start (start=${toIso(start)}, end=${toIso(end)})`,
      { start, end }
    );
  }
  const id = raw.id !== undefined ? raw.id : fallbackId;
  if (typeof id !== 'string' || id.length === 0) {
    throw new OeeError('INVALID_INTERVAL', 'interval.id must be a non-empty string', { value: raw });
  }
  return { id, device, start, end, state };
}

function compareIntervals(a, b) {
  return (
    a.start - b.start ||
    a.end - b.end ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function serializeInterval(iv) {
  return {
    id: iv.id,
    device: iv.device,
    state: iv.state,
    start: toIso(iv.start),
    end: toIso(iv.end),
  };
}

function serializeSession(s) {
  return {
    device: s.device,
    state: s.state,
    start: toIso(s.start),
    end: toIso(s.end),
    durationMs: s.end - s.start,
    sourceIds: s.sourceIds.slice(),
  };
}

function serializeShift(device, shiftIndex, metrics, anchor, length) {
  const start = anchor + shiftIndex * length;
  return {
    device,
    shiftIndex,
    start: toIso(start),
    end: toIso(start + length),
    runMs: metrics.runMs,
    idleMs: metrics.idleMs,
    failMs: metrics.failMs,
    maintMs: metrics.maintMs,
    plannedMs: metrics.plannedMs,
    availability: metrics.availability,
  };
}

function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

module.exports = {
  STATES,
  STATE_SET,
  OeeError,
  parseTime,
  toIso,
  normalizeInterval,
  compareIntervals,
  serializeInterval,
  serializeSession,
  serializeShift,
  canonical,
};
