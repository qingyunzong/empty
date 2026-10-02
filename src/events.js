export class DispatchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DispatchError';
    this.code = code;
  }
}

const RETRACT_KINDS = new Set(['carrier', 'tool', 'metro']);

function toTs(value, field, where) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new DispatchError('TS_INVALID', `${where}: invalid timestamp for ${field}`);
}

function reqStr(obj, field, where) {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new DispatchError('FIELD_INVALID', `${where}: missing or invalid string field ${field}`);
  }
  return value;
}

function reqNum(obj, field, where) {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DispatchError('FIELD_INVALID', `${where}: missing or invalid numeric field ${field}`);
  }
  return value;
}

export function parseEvent(obj, where = 'event') {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new DispatchError('PARSE_ERROR', `${where}: event must be a JSON object`);
  }
  const type = obj.type;
  switch (type) {
    case 'carrier': {
      const eventTs = toTs(obj.eventTs, 'eventTs', where);
      const qty = reqNum(obj, 'qty', where);
      if (qty < 0) throw new DispatchError('QTY_INVALID', `${where}: qty must be >= 0, got ${qty}`);
      const due = obj.due === undefined ? eventTs : toTs(obj.due, 'due', where);
      return {
        type, eventTs,
        carrier: reqStr(obj, 'carrier', where),
        lot: reqStr(obj, 'lot', where),
        qty,
        op: reqStr(obj, 'op', where),
        due,
      };
    }
    case 'tool': {
      const cap = reqNum(obj, 'cap', where);
      if (cap < 0) throw new DispatchError('CAP_INVALID', `${where}: cap must be >= 0, got ${cap}`);
      return {
        type,
        eventTs: toTs(obj.eventTs, 'eventTs', where),
        tool: reqStr(obj, 'tool', where),
        cap,
        windowStart: toTs(obj.windowStart, 'windowStart', where),
        windowEnd: toTs(obj.windowEnd, 'windowEnd', where),
        op: reqStr(obj, 'op', where),
      };
    }
    case 'metro':
      return {
        type,
        eventTs: toTs(obj.eventTs, 'eventTs', where),
        lot: reqStr(obj, 'lot', where),
        score: reqNum(obj, 'score', where),
        op: obj.op === undefined ? null : reqStr(obj, 'op', where),
      };
    case 'retract': {
      const kind = reqStr(obj, 'kind', where);
      if (!RETRACT_KINDS.has(kind)) {
        throw new DispatchError('KIND_INVALID', `${where}: retract kind must be one of carrier|tool|metro, got ${kind}`);
      }
      return {
        type,
        eventTs: toTs(obj.eventTs, 'eventTs', where),
        kind,
        id: reqStr(obj, 'id', where),
      };
    }
    default:
      throw new DispatchError('TYPE_UNKNOWN', `${where}: unknown event type ${JSON.stringify(type)}`);
  }
}

export function parseLine(line, where) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    throw new DispatchError('PARSE_ERROR', `${where}: invalid JSON`);
  }
  return parseEvent(obj, where);
}
