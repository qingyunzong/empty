import { schemaError, conflictError } from './errors.js';
import { TYPES } from './params.js';

export function validateEvent(raw, index = 0) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw schemaError(`event[${index}] must be an object`);
  }
  const { id, type, start, end } = raw;
  if (typeof id !== 'string' || id.length === 0) {
    throw schemaError(`event[${index}].id must be a non-empty string`, { id });
  }
  if (!TYPES.includes(type)) {
    throw schemaError(`event[${index}].type must be one of: ${TYPES.join(', ')}`, { type });
  }
  if (!Number.isSafeInteger(start)) {
    throw schemaError(`event[${index}].start must be a safe integer (epoch ms)`, { start });
  }
  if (!Number.isSafeInteger(end)) {
    throw schemaError(`event[${index}].end must be a safe integer (epoch ms)`, { end });
  }
  if (!(end > start)) {
    throw schemaError(`event[${index}] must satisfy end > start`, { start, end });
  }
  return { id, type, start, end };
}

export function validateEvents(raw) {
  if (!Array.isArray(raw)) throw schemaError('events must be an array');
  const out = [];
  const byId = new Map();
  for (let i = 0; i < raw.length; i++) {
    const event = validateEvent(raw[i], i);
    const prev = byId.get(event.id);
    if (prev) {
      const identical = prev.type === event.type && prev.start === event.start && prev.end === event.end;
      if (identical) continue; // exact re-delivery: dedup silently
      throw conflictError(`duplicate event id "${event.id}" with conflicting payload`, {
        first: prev,
        second: event,
      });
    }
    byId.set(event.id, event);
    out.push(event);
  }
  return out;
}
