import { TempRangeError, ParseError } from './errors.js';

export const EVENT_TYPES = new Set(['temp', 'door', 'ship', 'repair', 'retract']);
export const RETRACTABLE_KINDS = new Set(['temp', 'door', 'ship', 'repair']);
export const RETRACT_OPS = new Set(['retract', 'delete', 'del', 'remove']);

export const PHYSICAL_MIN_C = -273.15;
export const PHYSICAL_MAX_C = 100;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireFields(record, fields, where) {
  for (const field of fields) {
    if (record[field] === undefined || record[field] === null) {
      throw new ParseError(`missing field "${field}"`, { where, record });
    }
  }
}

function normalizeType(record) {
  const type = record.type ?? record.kind;
  if (typeof type !== 'string' || !EVENT_TYPES.has(type)) {
    throw new ParseError(`unknown event type: ${String(type)}`, { record });
  }
  return type;
}

function normalizeOp(record) {
  const op = record.op ?? 'add';
  if (typeof op !== 'string') {
    throw new ParseError('op must be a string', { record });
  }
  return op.toLowerCase();
}

function validateTemp(record, where) {
  requireFields(record, ['eventTs', 'zone', 'c'], where);
  if (!isFiniteNumber(record.eventTs)) throw new ParseError('eventTs must be a finite number (epoch ms)', { where, record });
  if (typeof record.zone !== 'string' || record.zone.length === 0) throw new ParseError('zone must be a non-empty string', { where, record });
  if (!isFiniteNumber(record.c)) throw new ParseError('c must be a finite number', { where, record });
  if (record.c < PHYSICAL_MIN_C || record.c > PHYSICAL_MAX_C) {
    throw new TempRangeError(
      `temperature ${record.c}C outside physical range [${PHYSICAL_MIN_C}, ${PHYSICAL_MAX_C}]`,
      { where, record },
    );
  }
}

function validateDoor(record, where) {
  requireFields(record, ['eventTs', 'zone', 'open'], where);
  if (!isFiniteNumber(record.eventTs)) throw new ParseError('eventTs must be a finite number (epoch ms)', { where, record });
  if (typeof record.zone !== 'string' || record.zone.length === 0) throw new ParseError('zone must be a non-empty string', { where, record });
  if (typeof record.open !== 'boolean') throw new ParseError('open must be a boolean', { where, record });
}

function validateShip(record, where) {
  requireFields(record, ['eventTs', 'lot', 'zone', 'start', 'end'], where);
  if (!isFiniteNumber(record.eventTs)) throw new ParseError('eventTs must be a finite number (epoch ms)', { where, record });
  for (const field of ['lot', 'zone']) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      throw new ParseError(`${field} must be a non-empty string`, { where, record });
    }
  }
  if (!isFiniteNumber(record.start) || !isFiniteNumber(record.end)) {
    throw new ParseError('start/end must be finite numbers (epoch ms)', { where, record });
  }
  if (record.end < record.start) throw new ParseError('ship window end before start', { where, record });
}

function validateRepair(record, where) {
  requireFields(record, ['eventTs', 'sensor', 'ok'], where);
  if (!isFiniteNumber(record.eventTs)) throw new ParseError('eventTs must be a finite number (epoch ms)', { where, record });
  if (typeof record.sensor !== 'string' || record.sensor.length === 0) throw new ParseError('sensor must be a non-empty string', { where, record });
  if (typeof record.ok !== 'boolean') throw new ParseError('ok must be a boolean', { where, record });
}

function validateRetract(record, where) {
  requireFields(record, ['eventTs', 'kind', 'id'], where);
  if (!isFiniteNumber(record.eventTs)) throw new ParseError('eventTs must be a finite number (epoch ms)', { where, record });
  if (!RETRACTABLE_KINDS.has(record.kind)) {
    throw new ParseError(`retract kind must be one of ${[...RETRACTABLE_KINDS].join(',')}`, { where, record });
  }
  if (typeof record.id !== 'string' || record.id.length === 0) throw new ParseError('retract id must be a non-empty string', { where, record });
}

const VALIDATORS = { temp: validateTemp, door: validateDoor, ship: validateShip, repair: validateRepair, retract: validateRetract };

export function parseLine(line, where = '<input>') {
  let record;
  try {
    record = JSON.parse(line);
  } catch (err) {
    throw new ParseError(`invalid JSON: ${err.message}`, { where, line });
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new ParseError('event must be a JSON object', { where, line });
  }
  const type = normalizeType(record);
  const op = normalizeOp(record);
  VALIDATORS[type](record, where);
  const event = { ...record, type, op };
  if (type === 'retract') return event;
  if (RETRACT_OPS.has(op) && (event.id === undefined || event.id === null || event.id === '')) {
    throw new ParseError('retracting op requires an id', { where, record });
  }
  return event;
}

export function* parseJsonl(text, source = '<input>') {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '' || line.startsWith('//')) continue;
    yield parseLine(line, `${source}:${index + 1}`);
  }
}
