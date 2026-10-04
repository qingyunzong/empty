import { createHash } from 'node:crypto';

export const DAY_MS = 86_400_000;
export const STATES = new Set(['up', 'down']);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function parseTime(value, field) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be an ISO 8601 string, got ${typeof value}`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new ValidationError(`${field} is not a valid time: ${JSON.stringify(value)}`);
  }
  return ms;
}

export function dayStartMs(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function dayString(dayMs) {
  return new Date(dayMs).toISOString().slice(0, 10);
}

export function validateBatch(batch) {
  if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) {
    throw new ValidationError('batch must be a JSON object');
  }
  if (typeof batch.tx_id !== 'string' || batch.tx_id.length === 0) {
    throw new ValidationError('tx_id must be a non-empty string');
  }
  const txMs = parseTime(batch.tx_time, 'tx_time');
  if (!Array.isArray(batch.events) || batch.events.length === 0) {
    throw new ValidationError('events must be a non-empty array');
  }
  const events = batch.events.map((event, index) => {
    const at = `events[${index}]`;
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new ValidationError(`${at} must be an object`);
    }
    if (typeof event.id !== 'string' || event.id.length === 0) {
      throw new ValidationError(`${at}.id must be a non-empty string`);
    }
    if (typeof event.equipment !== 'string' || event.equipment.length === 0) {
      throw new ValidationError(`${at}.equipment must be a non-empty string`);
    }
    const validMs = parseTime(event.valid_time, `${at}.valid_time`);
    if (!STATES.has(event.state)) {
      throw new ValidationError(`${at}.state must be one of: up, down`);
    }
    return {
      id: event.id,
      equipment: event.equipment,
      valid_time: new Date(validMs).toISOString(),
      state: event.state,
    };
  });
  return { tx_id: batch.tx_id, tx_time: new Date(txMs).toISOString(), events };
}

export function hashCounts(counts) {
  const lines = [...counts.keys()]
    .sort()
    .map((day) => `${day},${counts.get(day).up},${counts.get(day).down}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}
