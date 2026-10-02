export const MAX_OPS = 12;

export class InvalidHistoryError extends Error {
  constructor(errors) {
    super(`INVALID_HISTORY: ${errors.join('; ')}`);
    this.name = 'InvalidHistoryError';
    this.code = 'INVALID_HISTORY';
    this.errors = errors;
  }
}

const OP_KINDS = new Set(['hold', 'capture', 'cancel', 'audit']);
const CAPTURE_ERRORS = new Set(['not_found', 'cancelled', 'expired', 'insufficient']);
const CANCEL_ERRORS = new Set(['not_found', 'cancelled']);
const AUDIT_ERRORS = new Set(['not_found']);

function isNonNegInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Validates the raw history document. Throws InvalidHistoryError on any
// malformed field, negative capture amount, or expired request.
// Returns the normalized operations array on success.
export function validateHistory(history) {
  const errors = [];
  if (history === null || typeof history !== 'object' || Array.isArray(history)) {
    throw new InvalidHistoryError(['history must be a JSON object']);
  }
  const ops = history.operations;
  if (!Array.isArray(ops)) {
    throw new InvalidHistoryError(['history.operations must be an array']);
  }
  if (ops.length > MAX_OPS) {
    errors.push(`too many operations: ${ops.length} > ${MAX_OPS}`);
  }

  const ids = new Set();
  const holdIds = new Set();
  const holdDeadline = new Map();

  ops.forEach((op, index) => {
    const where = `operations[${index}]${op && op.id !== undefined ? ` (${op.id})` : ''}`;
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      errors.push(`${where}: operation must be an object`);
      return;
    }
    if (typeof op.id !== 'string' || op.id === '') {
      errors.push(`${where}: id must be a non-empty string`);
    } else if (ids.has(op.id)) {
      errors.push(`${where}: duplicate operation id ${op.id}`);
    } else {
      ids.add(op.id);
    }
    if (!OP_KINDS.has(op.op)) {
      errors.push(`${where}: unknown op kind ${JSON.stringify(op.op)}`);
      return;
    }
    if (!isFiniteNumber(op.invoke) || !isFiniteNumber(op.respond) || op.invoke > op.respond) {
      errors.push(`${where}: require finite numbers invoke <= respond`);
    }
    if (!isNonNegInt(op.clock)) {
      errors.push(`${where}: clock must be a non-negative integer`);
    }
    if (!isNonNegInt(op.version)) {
      errors.push(`${where}: version must be a non-negative integer`);
    }
    if (op.response === null || typeof op.response !== 'object' || typeof op.response.ok !== 'boolean') {
      errors.push(`${where}: response.ok (boolean) is required`);
      return;
    }
    const res = op.response;
    switch (op.op) {
      case 'hold': {
        if (!isNonNegInt(op.amount)) errors.push(`${where}: hold amount must be a non-negative integer`);
        if (!isFiniteNumber(op.deadline)) errors.push(`${where}: hold deadline must be a finite number`);
        if (res.ok) {
          if (typeof res.holdId !== 'string' || res.holdId === '') {
            errors.push(`${where}: hold response requires holdId`);
          } else if (holdIds.has(res.holdId)) {
            errors.push(`${where}: duplicate holdId ${res.holdId}`);
          } else {
            holdIds.add(res.holdId);
            if (isFiniteNumber(op.deadline)) holdDeadline.set(res.holdId, op.deadline);
          }
        } else {
          errors.push(`${where}: hold responses must be ok`);
        }
        break;
      }
      case 'capture': {
        if (typeof op.holdId !== 'string') errors.push(`${where}: capture requires holdId`);
        if (!Number.isInteger(op.amount) || op.amount < 0) {
          errors.push(`${where}: capture amount must be a non-negative integer (negative capture)`);
        }
        if (res.ok) {
          if (!isNonNegInt(res.totalCaptured)) {
            errors.push(`${where}: capture response requires totalCaptured >= 0`);
          }
        } else if (!CAPTURE_ERRORS.has(res.error)) {
          errors.push(`${where}: unknown capture error ${JSON.stringify(res.error)}`);
        }
        break;
      }
      case 'cancel': {
        if (typeof op.holdId !== 'string') errors.push(`${where}: cancel requires holdId`);
        if (res.ok) {
          if (!isNonNegInt(res.released)) errors.push(`${where}: cancel response requires released >= 0`);
        } else if (!CANCEL_ERRORS.has(res.error)) {
          errors.push(`${where}: unknown cancel error ${JSON.stringify(res.error)}`);
        }
        break;
      }
      case 'audit': {
        if (typeof op.holdId !== 'string') errors.push(`${where}: audit requires holdId`);
        if (res.ok) {
          for (const field of ['frozen', 'captured', 'available']) {
            if (!isNonNegInt(res[field])) errors.push(`${where}: audit response requires ${field} >= 0`);
          }
        } else if (!AUDIT_ERRORS.has(res.error)) {
          errors.push(`${where}: unknown audit error ${JSON.stringify(res.error)}`);
        }
        break;
      }
      default:
        break;
    }
  });

  // Expired requests: a capture/cancel issued after the hold's deadline.
  ops.forEach((op, index) => {
    if (op === null || typeof op !== 'object') return;
    if (op.op !== 'capture' && op.op !== 'cancel') return;
    const deadline = holdDeadline.get(op.holdId);
    if (deadline !== undefined && isFiniteNumber(op.invoke) && op.invoke > deadline) {
      errors.push(`operations[${index}] (${op.id}): expired request, invoke ${op.invoke} is past deadline ${deadline}`);
    }
  });

  if (errors.length > 0) throw new InvalidHistoryError(errors);
  return ops;
}
