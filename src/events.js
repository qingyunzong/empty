import { TraceError } from './errors.js';

const KINDS = new Set(['torque', 'calib', 'scan', 'retract']);

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireField(raw, field, source) {
  if (raw[field] === undefined || raw[field] === null) {
    throw new TraceError('BAD_EVENT', `missing field "${field}" at ${source}`);
  }
  return raw[field];
}

function requireNumber(raw, field, source) {
  const value = requireField(raw, field, source);
  if (!isFiniteNumber(value)) {
    throw new TraceError('BAD_EVENT', `field "${field}" must be a finite number at ${source}`);
  }
  return value;
}

function requireString(raw, field, source) {
  const value = requireField(raw, field, source);
  if (typeof value !== 'string' || value.length === 0) {
    throw new TraceError('BAD_EVENT', `field "${field}" must be a non-empty string at ${source}`);
  }
  return value;
}

function requireId(raw, source) {
  const value = requireField(raw, 'id', source);
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TraceError('BAD_EVENT', `field "id" must be a string or number at ${source}`);
  }
  return String(value);
}

export function normalizeEvent(raw, source = 'event') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TraceError('BAD_EVENT', `event must be a JSON object at ${source}`);
  }
  const kind = requireString(raw, 'type', source);
  if (!KINDS.has(kind)) {
    throw new TraceError('BAD_EVENT', `unknown event type "${kind}" at ${source}`);
  }
  const eventTs = requireNumber(raw, 'eventTs', source);

  switch (kind) {
    case 'torque':
      return {
        kind,
        id: requireId(raw, source),
        eventTs,
        bolt: requireString(raw, 'bolt', source),
        tool: requireString(raw, 'tool', source),
        peak: requireNumber(raw, 'peak', source),
        angle: requireNumber(raw, 'angle', source),
        op: raw.op ?? null,
      };
    case 'calib': {
      const validFrom = requireNumber(raw, 'validFrom', source);
      const validTo = requireNumber(raw, 'validTo', source);
      if (validFrom > validTo) {
        throw new TraceError('BAD_EVENT', `validFrom must be <= validTo at ${source}`);
      }
      const ok = requireField(raw, 'ok', source);
      if (typeof ok !== 'boolean') {
        throw new TraceError('BAD_EVENT', `field "ok" must be a boolean at ${source}`);
      }
      return {
        kind,
        id: requireId(raw, source),
        eventTs,
        tool: requireString(raw, 'tool', source),
        ok,
        validFrom,
        validTo,
        op: raw.op ?? null,
      };
    }
    case 'scan':
      return {
        kind,
        id: requireId(raw, source),
        eventTs,
        bolt: requireString(raw, 'bolt', source),
        lot: requireString(raw, 'lot', source),
        op: raw.op ?? null,
      };
    case 'retract': {
      const targetKind = requireString(raw, 'kind', source);
      if (targetKind === 'retract' || !KINDS.has(targetKind)) {
        throw new TraceError('BAD_EVENT', `retract kind must be torque|calib|scan at ${source}`);
      }
      return {
        kind,
        id: `retract#${targetKind}#${requireId(raw, source)}`,
        eventTs,
        targetKind,
        targetId: requireId(raw, source),
      };
    }
    default:
      throw new TraceError('BAD_EVENT', `unhandled event type at ${source}`);
  }
}

export function parseLine(line, source) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new TraceError('PARSE_ERROR', `invalid JSON at ${source}`);
  }
  return normalizeEvent(raw, source);
}
