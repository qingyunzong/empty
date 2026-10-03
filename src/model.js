import { PlanError } from './errors.js';

export function toTs(value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  throw new PlanError('SCHEMA_INVALID', `field "${field}" must be epoch ms or an ISO-8601 time string`);
}

function reqString(obj, field) {
  const v = obj[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new PlanError('SCHEMA_INVALID', `field "${field}" must be a non-empty string`);
  }
  return v;
}

function reqNumber(obj, field, { integer = false } = {}) {
  const v = obj[field];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) {
    throw new PlanError('SCHEMA_INVALID', `field "${field}" must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return v;
}

export function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlanError('SCHEMA_INVALID', 'event must be a JSON object');
  }
  const type = raw.type;
  if (type === 'order') {
    const ev = {
      type,
      arriveTs: toTs(raw.arriveTs, 'arriveTs'),
      eventTs: toTs(raw.eventTs, 'eventTs'),
      job: reqString(raw, 'job'),
      mold: reqString(raw, 'mold'),
      due: toTs(raw.due, 'due'),
      qty: reqNumber(raw, 'qty', { integer: true }),
      op: reqNumber(raw, 'op'),
    };
    if (ev.due < ev.eventTs) {
      throw new PlanError('DUE_INVALID', `order ${ev.job}: due (${ev.due}) is earlier than eventTs (${ev.eventTs})`);
    }
    return ev;
  }
  if (type === 'maint') {
    const ev = {
      type,
      eventTs: toTs(raw.eventTs, 'eventTs'),
      machine: reqString(raw, 'machine'),
      start: toTs(raw.start, 'start'),
      end: toTs(raw.end, 'end'),
      op: raw.op === undefined ? null : raw.op,
    };
    if (ev.end <= ev.start) {
      throw new PlanError('WINDOW_INVALID', `maint on ${ev.machine}: end must be after start`);
    }
    ev.id = typeof raw.id === 'string' && raw.id.length > 0
      ? raw.id
      : `${ev.machine}:${ev.start}-${ev.end}`;
    return ev;
  }
  if (type === 'retract') {
    const kind = raw.kind;
    if (kind !== 'order' && kind !== 'maint') {
      throw new PlanError('SCHEMA_INVALID', 'retract.kind must be "order" or "maint"');
    }
    return { type, eventTs: toTs(raw.eventTs, 'eventTs'), kind, id: reqString(raw, 'id') };
  }
  throw new PlanError('SCHEMA_INVALID', `unknown event type: ${JSON.stringify(type)}`);
}
