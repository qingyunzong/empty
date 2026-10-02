// History validation. Any format error, negative capture, or expired request
// is reported as INVALID_HISTORY via InvalidHistoryError.

export class InvalidHistoryError extends Error {
  constructor(errors) {
    super(`INVALID_HISTORY: ${errors.join('; ')}`);
    this.name = 'InvalidHistoryError';
    this.errors = errors;
  }
}

const OP_KINDS = new Set(['hold', 'capture', 'cancel', 'audit']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isStr = (v) => typeof v === 'string' && v.length > 0;

export function validateHistory(input) {
  if (typeof input !== 'object' || input === null || !Array.isArray(input.operations)) {
    throw new InvalidHistoryError(['root must be an object with an "operations" array']);
  }
  const errors = [];
  const ops = [];
  const ids = new Set();

  input.operations.forEach((raw, index) => {
    const where = `operations[${index}]`;
    if (typeof raw !== 'object' || raw === null) {
      errors.push(`${where}: must be an object`);
      return;
    }
    const id = raw.id === undefined ? `op${index}` : raw.id;
    if (!isStr(id)) errors.push(`${where}.id: must be a non-empty string`);
    else if (ids.has(id)) errors.push(`${where}.id: duplicate id "${id}"`);
    else ids.add(id);

    if (!OP_KINDS.has(raw.op)) errors.push(`${where}.op: must be one of hold|capture|cancel|audit`);
    if (!isNum(raw.invoke)) errors.push(`${where}.invoke: must be a number`);
    if (!isNum(raw.respond)) errors.push(`${where}.respond: must be a number`);
    if (isNum(raw.invoke) && isNum(raw.respond) && raw.invoke > raw.respond) {
      errors.push(`${where}: invoke must be <= respond`);
    }
    if (!isNonNegInt(raw.clock)) errors.push(`${where}.clock: must be a non-negative integer`);
    if (!isPosInt(raw.version)) errors.push(`${where}.version: must be a positive integer`);

    const op = { id, op: raw.op, invoke: raw.invoke, respond: raw.respond, clock: raw.clock, version: raw.version };

    switch (raw.op) {
      case 'hold':
        if (!isStr(raw.holdId)) errors.push(`${where}.holdId: must be a non-empty string`);
        if (!isPosInt(raw.amount)) errors.push(`${where}.amount: must be a positive integer`);
        if (!isNum(raw.deadline)) errors.push(`${where}.deadline: must be a number`);
        else if (isNum(raw.invoke) && raw.deadline < raw.invoke) {
          errors.push(`${where}.deadline: must be >= invoke`);
        }
        Object.assign(op, { holdId: raw.holdId, amount: raw.amount, deadline: raw.deadline });
        break;
      case 'capture':
        if (!isStr(raw.holdId)) errors.push(`${where}.holdId: must be a non-empty string`);
        if (typeof raw.amount === 'number' && raw.amount < 0) {
          errors.push(`${where}.amount: negative capture`);
        } else if (!isPosInt(raw.amount)) {
          errors.push(`${where}.amount: must be a positive integer`);
        }
        if (!isNonNegInt(raw.captured)) {
          errors.push(`${where}.captured: response total must be a non-negative integer`);
        }
        Object.assign(op, { holdId: raw.holdId, amount: raw.amount, captured: raw.captured });
        break;
      case 'cancel':
        if (!isStr(raw.holdId)) errors.push(`${where}.holdId: must be a non-empty string`);
        op.holdId = raw.holdId;
        break;
      case 'audit': {
        if (!isStr(raw.holdId)) errors.push(`${where}.holdId: must be a non-empty string`);
        const r = raw.result;
        if (typeof r !== 'object' || r === null) {
          errors.push(`${where}.result: must be an object {frozen, captured, available}`);
        } else {
          for (const k of ['frozen', 'captured', 'available']) {
            if (!isNonNegInt(r[k])) errors.push(`${where}.result.${k}: must be a non-negative integer`);
          }
        }
        Object.assign(op, { holdId: raw.holdId, result: r });
        break;
      }
    }
    ops.push(op);
  });

  // Cross-operation checks: referenced holds must exist; captures must not be expired.
  const holds = new Map();
  for (const op of ops) {
    if (op.op === 'hold' && isStr(op.holdId)) {
      if (holds.has(op.holdId)) errors.push(`duplicate holdId "${op.holdId}"`);
      else holds.set(op.holdId, op);
    }
  }
  for (const op of ops) {
    if (op.op === 'capture' || op.op === 'cancel' || op.op === 'audit') {
      if (!isStr(op.holdId)) continue;
      const hold = holds.get(op.holdId);
      if (!hold) {
        errors.push(`${op.id}: unknown holdId "${op.holdId}"`);
      } else if (op.op === 'capture' && isNum(op.invoke) && isNum(hold.deadline) && op.invoke > hold.deadline) {
        errors.push(`${op.id}: expired request, capture invoked at ${op.invoke} after deadline ${hold.deadline}`);
      }
    }
  }

  if (errors.length) throw new InvalidHistoryError(errors);
  return ops;
}
