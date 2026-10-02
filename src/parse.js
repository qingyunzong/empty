import { DispatchError } from './errors.js';

export const RETRACT_TARGETS = new Set(['carrier', 'tool', 'metro']);
const SET_OPS = new Set(['add', 'upsert']);
const DEL_OPS = new Set(['del', 'remove']);

export function toMs(ts, field = 'eventTs') {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string') {
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new DispatchError('TS_INVALID', `invalid timestamp for ${field}: ${JSON.stringify(ts)}`);
}

export function iso(ms) {
  return new Date(ms).toISOString();
}

function need(obj, field, where) {
  if (obj[field] === undefined || obj[field] === null) {
    throw new DispatchError('SCHEMA_INVALID', `missing field "${field}" in ${where}`);
  }
  return obj[field];
}

function needString(obj, field, where) {
  const v = need(obj, field, where);
  if (typeof v !== 'string' || v.length === 0) {
    throw new DispatchError('SCHEMA_INVALID', `field "${field}" must be a non-empty string in ${where}`);
  }
  return v;
}

function needNumber(obj, field, where) {
  const v = need(obj, field, where);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new DispatchError('SCHEMA_INVALID', `field "${field}" must be a finite number in ${where}`);
  }
  return v;
}

function parseOp(obj, where) {
  const op = obj.op === undefined ? 'add' : obj.op;
  if (SET_OPS.has(op)) return 'set';
  if (DEL_OPS.has(op)) return 'del';
  throw new DispatchError('INVALID_OP', `unknown op "${op}" in ${where}`);
}

// Event type is inferred from fields (an explicit "type" discriminator is also
// accepted): carrier{carrier,lot,qty}, tool{tool,cap,windowStart,windowEnd},
// metro{lot,score}, retract{kind:carrier|tool|metro,id}.
function inferType(raw, where) {
  if (raw.type !== undefined) {
    const t = raw.type;
    if (!['carrier', 'tool', 'metro', 'retract'].includes(t)) {
      throw new DispatchError('KIND_INVALID', `unknown event type "${t}" in ${where}`);
    }
    return t;
  }
  if (raw.carrier !== undefined) return 'carrier';
  if (raw.tool !== undefined) return 'tool';
  if (raw.retract !== undefined) return 'retract';
  if (raw.kind !== undefined && RETRACT_TARGETS.has(raw.kind) && raw.id !== undefined) return 'retract';
  if (raw.lot !== undefined && raw.score !== undefined) return 'metro';
  throw new DispatchError('KIND_INVALID', `cannot infer event type in ${where}`);
}

export function parseEvent(raw, where = 'event') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DispatchError('SCHEMA_INVALID', `${where}: event must be an object`);
  }
  const type = inferType(raw, where);
  const eventTs = toMs(need(raw, 'eventTs', where), 'eventTs');

  if (type === 'carrier') {
    const id = needString(raw, 'carrier', where);
    const lot = needString(raw, 'lot', where);
    const qty = needNumber(raw, 'qty', where);
    if (qty <= 0) throw new DispatchError('QTY_INVALID', `qty must be > 0 for carrier "${id}"`);
    const op = parseOp(raw, where);
    const due = raw.due === undefined ? eventTs : toMs(raw.due, 'due');
    return { type, eventTs, op, id, lot, qty, due };
  }
  if (type === 'tool') {
    const id = needString(raw, 'tool', where);
    const cap = needNumber(raw, 'cap', where);
    if (cap < 0) throw new DispatchError('CAP_INVALID', `cap must be >= 0 for tool "${id}", got ${cap}`);
    const windowStart = toMs(need(raw, 'windowStart', where), 'windowStart');
    const windowEnd = toMs(need(raw, 'windowEnd', where), 'windowEnd');
    if (windowStart > windowEnd) {
      throw new DispatchError('WINDOW_INVALID', `windowStart > windowEnd for tool "${id}"`);
    }
    const op = parseOp(raw, where);
    return { type, eventTs, op, id, cap, windowStart, windowEnd };
  }
  if (type === 'metro') {
    const lot = needString(raw, 'lot', where);
    const score = needNumber(raw, 'score', where);
    const op = parseOp(raw, where);
    return { type, eventTs, op, id: lot, lot, score };
  }
  // retract(eventTs, kind, id): "kind" names the retracted entity type.
  const target = raw.kind !== undefined ? raw.kind : needString(raw, 'retract', where);
  if (!RETRACT_TARGETS.has(target)) {
    throw new DispatchError('KIND_INVALID', `retract kind must be carrier|tool|metro, got "${target}"`);
  }
  const id = needString(raw, 'id', where);
  return { type, eventTs, op: 'del', target, id };
}
