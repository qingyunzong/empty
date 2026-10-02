'use strict';

const { DomainError } = require('./errors');

const STATES = Object.freeze(['RUN', 'IDLE', 'FAIL', 'MAINT']);
const STATE_SET = new Set(STATES);

function toMs(value, field) {
  let ms;
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value;
  } else if (typeof value === 'string') {
    ms = Date.parse(value);
  } else {
    ms = NaN;
  }
  if (!Number.isFinite(ms)) {
    throw new DomainError('INVALID_TIME', `invalid timestamp for "${field}": ${JSON.stringify(value)}`);
  }
  return ms;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEvent(raw, fallbackId) {
  if (!isPlainObject(raw)) {
    throw new DomainError('INVALID_EVENT', 'event must be an object with start, end and state');
  }
  const id = raw.id !== undefined && raw.id !== null ? String(raw.id) : fallbackId;
  if (!id) {
    throw new DomainError('INVALID_EVENT', 'event is missing a non-empty "id"');
  }
  const startMs = toMs(raw.start, 'start');
  const endMs = toMs(raw.end, 'end');
  if (endMs <= startMs) {
    throw new DomainError('BACKWARD_CLOCK', `event "${id}" has end <= start (${toIso(startMs)} .. ${toIso(endMs)})`, { id });
  }
  if (!STATE_SET.has(raw.state)) {
    throw new DomainError('UNKNOWN_STATE', `event "${id}" has unknown state ${JSON.stringify(raw.state)}; expected one of ${STATES.join(', ')}`, { id, state: raw.state });
  }
  return { id, startMs, endMs, state: raw.state };
}

function normalizeShift(raw) {
  if (!isPlainObject(raw)) {
    throw new DomainError('INVALID_SHIFT', 'shift must be an object with id, start and end');
  }
  const id = raw.id !== undefined && raw.id !== null ? String(raw.id) : '';
  if (!id) {
    throw new DomainError('INVALID_SHIFT', 'shift is missing a non-empty "id"');
  }
  const startMs = toMs(raw.start, 'shift.start');
  const endMs = toMs(raw.end, 'shift.end');
  if (endMs <= startMs) {
    throw new DomainError('BACKWARD_CLOCK', `shift "${id}" has end <= start`, { id });
  }
  return { id, startMs, endMs };
}

module.exports = { STATES, STATE_SET, DomainError, toMs, toIso, isPlainObject, normalizeEvent, normalizeShift };
