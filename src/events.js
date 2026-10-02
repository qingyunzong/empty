export class PlanError extends Error {
  constructor(code, msg) {
    super(msg);
    this.name = 'PlanError';
    this.code = code;
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

function req(obj, field, at) {
  if (!(field in obj)) {
    throw new PlanError('MISSING_FIELD', `${at}: missing field "${field}"`);
  }
  return obj[field];
}

function reqNum(obj, field, at) {
  const v = req(obj, field, at);
  if (!isNum(v)) {
    throw new PlanError('INVALID_FIELD', `${at}: field "${field}" must be a finite number`);
  }
  return v;
}

function reqStr(obj, field, at) {
  const v = req(obj, field, at);
  if (!isStr(v)) {
    throw new PlanError('INVALID_FIELD', `${at}: field "${field}" must be a non-empty string`);
  }
  return v;
}

function reqOp(obj, at) {
  const op = req(obj, 'op', at);
  if (op !== 'add') {
    throw new PlanError('INVALID_OP', `${at}: unsupported op ${JSON.stringify(op)} (use retract events to remove)`);
  }
  return op;
}

export function parseEvent(line, at) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    throw new PlanError('PARSE_ERROR', `${at}: invalid JSON`);
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new PlanError('PARSE_ERROR', `${at}: event must be a JSON object`);
  }
  const type = req(obj, 'type', at);
  if (type === 'order') return parseOrder(obj, at);
  if (type === 'maint') return parseMaint(obj, at);
  if (type === 'retract') return parseRetract(obj, at);
  throw new PlanError('UNKNOWN_TYPE', `${at}: unknown event type ${JSON.stringify(type)}`);
}

function parseOrder(obj, at) {
  const arriveTs = reqNum(obj, 'arriveTs', at);
  const eventTs = reqNum(obj, 'eventTs', at);
  const job = reqStr(obj, 'job', at);
  const mold = reqStr(obj, 'mold', at);
  const due = reqNum(obj, 'due', at);
  const qty = reqNum(obj, 'qty', at);
  reqOp(obj, at);
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new PlanError('INVALID_QTY', `${at}: qty must be a positive integer, got ${qty}`);
  }
  if (due < eventTs) {
    throw new PlanError('DUE_INVALID', `${at}: order ${job} due (${due}) is earlier than its event time (${eventTs})`);
  }
  return { type: 'order', arriveTs, eventTs, job, mold, due, qty, op: 'add' };
}

function parseMaint(obj, at) {
  const eventTs = reqNum(obj, 'eventTs', at);
  const machine = reqStr(obj, 'machine', at);
  const start = reqNum(obj, 'start', at);
  const end = reqNum(obj, 'end', at);
  reqOp(obj, at);
  if (end <= start) {
    throw new PlanError('INVALID_INTERVAL', `${at}: maint window end (${end}) must be after start (${start})`);
  }
  const id = isStr(obj.id) ? obj.id : `${machine}:${start}:${end}`;
  return { type: 'maint', eventTs, machine, start, end, op: 'add', id };
}

function parseRetract(obj, at) {
  const eventTs = reqNum(obj, 'eventTs', at);
  const kind = req(obj, 'kind', at);
  if (kind !== 'order' && kind !== 'maint') {
    throw new PlanError('INVALID_KIND', `${at}: retract kind must be "order" or "maint", got ${JSON.stringify(kind)}`);
  }
  const id = reqStr(obj, 'id', at);
  return { type: 'retract', eventTs, kind, id };
}
