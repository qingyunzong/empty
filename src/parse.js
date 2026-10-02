import { AgvError } from './errors.js';

const REQUIRED_FIELDS = {
  reserve: ['eventTs', 'agv', 'edge', 'id'],
  ping: ['eventTs', 'agv', 'node', 'speed'],
  cancel: ['eventTs', 'reserveId'],
  retract: ['eventTs', 'kind', 'id'],
};

const RETRACT_KINDS = new Set(['ping', 'reserve']);

export function parseEvent(line, where) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    throw new AgvError('BAD_JSON', `${where}: line is not valid JSON`);
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new AgvError('INVALID_EVENT', `${where}: event must be a JSON object`);
  }
  const op = obj.op;
  if (typeof op !== 'string' || !Object.hasOwn(REQUIRED_FIELDS, op)) {
    throw new AgvError('INVALID_EVENT', `${where}: unknown op ${JSON.stringify(op)}`);
  }
  for (const field of REQUIRED_FIELDS[op]) {
    if (!(field in obj)) {
      throw new AgvError('INVALID_EVENT', `${where}: op "${op}" missing field "${field}"`);
    }
  }
  if (typeof obj.eventTs !== 'number' || !Number.isFinite(obj.eventTs)) {
    throw new AgvError('INVALID_EVENT', `${where}: eventTs must be a finite number`);
  }
  if (op === 'retract' && !RETRACT_KINDS.has(obj.kind)) {
    throw new AgvError('INVALID_EVENT', `${where}: retract kind must be "ping" or "reserve"`);
  }
  return obj;
}

export function parseJsonl(text, sourceName) {
  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    const where = `${sourceName}:${i + 1}`;
    const event = parseEvent(trimmed, where);
    events.push({ ...event, _where: where });
  }
  return events;
}
