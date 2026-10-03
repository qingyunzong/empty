import { AuditError, E_TIME_ORDER, E_TOMBSTONE, E_REF } from './errors.js';

export function parseTime(value, field) {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new AuditError(E_TIME_ORDER, `invalid timestamp for ${field}: ${JSON.stringify(value)}`);
  }
  return ms;
}

function nullableNumber(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AuditError(E_REF, `payload.${field} must be a finite number or null`);
  }
  return value;
}

// Validates and normalizes a raw JSONL record into an internal event.
// Throws AuditError(E_TIME_ORDER | E_TOMBSTONE | E_REF) on violation.
export function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuditError(E_REF, 'event must be a JSON object');
  }
  const {
    id, account, validFrom, validTo = null, txSeq,
    payload = null, supersedes = null, tombstone = false,
  } = raw;

  if (typeof id !== 'string' || id.length === 0) {
    throw new AuditError(E_REF, 'event.id must be a non-empty string');
  }
  if (typeof account !== 'string' || account.length === 0) {
    throw new AuditError(E_REF, `event ${id}: account must be a non-empty string`);
  }
  if (!Number.isInteger(txSeq) || txSeq < 1) {
    throw new AuditError(E_TIME_ORDER, `event ${id}: txSeq must be a positive integer`);
  }
  const validFromMs = parseTime(validFrom, 'validFrom');
  if (validFromMs === null) {
    throw new AuditError(E_TIME_ORDER, `event ${id}: validFrom is required`);
  }
  const validToMs = validTo === null ? null : parseTime(validTo, 'validTo');
  if (validToMs !== null && validToMs <= validFromMs) {
    throw new AuditError(E_TIME_ORDER,
      `event ${id}: validTo (${validTo}) must be strictly after validFrom (${validFrom})`);
  }
  if (supersedes !== null && typeof supersedes !== 'string') {
    throw new AuditError(E_REF, `event ${id}: supersedes must be an event id or null`);
  }
  if (tombstone !== false && tombstone !== true) {
    throw new AuditError(E_REF, `event ${id}: tombstone must be a boolean`);
  }
  if (tombstone && supersedes === null) {
    throw new AuditError(E_TOMBSTONE, `event ${id}: tombstone must supersede an existing version`);
  }

  let amount = null;
  let limit = null;
  if (!tombstone && payload !== null) {
    if (typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AuditError(E_REF, `event ${id}: payload must be an object or null`);
    }
    amount = nullableNumber(payload.amount, 'amount');
    limit = nullableNumber(payload.limit, 'limit');
  }

  return {
    id, account, validFrom, validTo, validFromMs, validToMs, txSeq,
    amount, limit, supersedes, tombstone, root: null,
  };
}
