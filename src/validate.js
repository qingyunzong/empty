const TYPES = new Set(['FLUX', 'CALIBRATION']);
const OPS = new Set(['UPSERT', 'RETRACT']);

function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function malformed(message) {
  return { error: { code: 'MALFORMED', message } };
}

export function validateEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return malformed('event must be a JSON object');
  }
  const { type, op, id } = raw;
  if (!TYPES.has(type)) return malformed(`unknown type: ${String(type)}`);
  if (!OPS.has(op)) return malformed(`unknown op: ${String(op)}`);
  if (typeof id !== 'string' || id.length === 0) {
    return malformed('id must be a non-empty string');
  }
  if (op === 'RETRACT') return { event: { type, op, id } };

  const { sensorId } = raw;
  if (typeof sensorId !== 'string' || sensorId.length === 0) {
    return malformed('sensorId must be a non-empty string');
  }

  if (type === 'FLUX') {
    const ts = parseTime(raw.ts);
    if (ts === null) return malformed('ts must be an ISO-8601 string or epoch ms number');
    const { value } = raw;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return malformed('value must be a finite number');
    }
    return { event: { type, op, id, sensorId, ts, value } };
  }

  const { version } = raw;
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return malformed('version must be a finite number');
  }
  const effectiveFrom = parseTime(raw.effectiveFrom);
  const expireAt = parseTime(raw.expireAt);
  if (effectiveFrom === null || expireAt === null) {
    return malformed('effectiveFrom/expireAt must be ISO-8601 strings or epoch ms numbers');
  }
  if (effectiveFrom >= expireAt) {
    return { error: { code: 'INVALID_RANGE', message: 'effectiveFrom must be before expireAt' } };
  }
  const factor = raw.factor === undefined ? 1 : raw.factor;
  const offset = raw.offset === undefined ? 0 : raw.offset;
  if (typeof factor !== 'number' || !Number.isFinite(factor)) {
    return malformed('factor must be a finite number');
  }
  if (typeof offset !== 'number' || !Number.isFinite(offset)) {
    return malformed('offset must be a finite number');
  }
  return { event: { type, op, id, sensorId, version, effectiveFrom, expireAt, factor, offset } };
}
