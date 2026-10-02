import { DiagnosticError } from './errors.js';

// Event JSONL format (one JSON object per line):
//   data event:       {"id":"e1","time":"2026-01-01T00:00:00Z","device":"sensor-1","type":"temp","value":85}
//   correction:       same as a data event plus "replaces":"<id>"
//   retraction:       {"id":"e3","retracts":"<id>"}
// time may be an ISO-8601 string or epoch milliseconds (number).

export function parseTime(value, fail) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  fail('"time" must be an ISO-8601 string or epoch milliseconds');
}

// Validates one parsed JSON value into a normalized event.
// fields: Map of declared field names (event "type" must be declared).
export function normalizeEvent(raw, eventLine, fields) {
  const fail = (msg) => { throw new DiagnosticError(msg, { phase: 'event', event: eventLine }); };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('event must be a JSON object');
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    fail('event must have a non-empty string "id"');
  }
  const hasReplaces = raw.replaces !== undefined;
  const hasRetracts = raw.retracts !== undefined;
  if (hasReplaces && hasRetracts) fail('event cannot have both "replaces" and "retracts"');

  if (hasRetracts) {
    if (typeof raw.retracts !== 'string' || raw.retracts.length === 0) {
      fail('"retracts" must be a non-empty string event id');
    }
    return Object.freeze({ id: raw.id, retracts: raw.retracts });
  }

  const time = parseTime(raw.time, fail);
  if (typeof raw.device !== 'string' || raw.device.length === 0) {
    fail('event must have a non-empty string "device"');
  }
  if (typeof raw.type !== 'string' || !fields.has(raw.type)) {
    fail(`event "type" must be a declared field (got ${JSON.stringify(raw.type)})`);
  }
  if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) {
    fail('event "value" must be a finite number');
  }
  const ev = { id: raw.id, time, device: raw.device, type: raw.type, value: raw.value };
  if (hasReplaces) {
    if (typeof raw.replaces !== 'string' || raw.replaces.length === 0) {
      fail('"replaces" must be a non-empty string event id');
    }
    ev.replaces = raw.replaces;
  }
  return Object.freeze(ev);
}

// Canonical string used to detect exact duplicates (idempotent re-delivery).
export function canonicalEvent(ev) {
  return JSON.stringify([ev.id, ev.time ?? null, ev.device ?? null, ev.type ?? null,
    ev.value ?? null, ev.replaces ?? null, ev.retracts ?? null]);
}
