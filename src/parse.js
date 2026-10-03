export const PHYSICAL_MIN_C = -100;
export const PHYSICAL_MAX_C = 100;
export const DEFAULT_WATERMARK_LAG_MS = 120000;

export class ColdError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ColdError';
    this.code = code;
  }
}

const KINDS = new Set(['temp', 'door', 'ship', 'repair', 'retract']);
const DELETE_OPS = new Set(['del', 'delete', 'retract', 'remove']);

function need(cond, code, msg) {
  if (!cond) throw new ColdError(code, msg);
}

export function toMs(value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new ColdError('BAD_TIMESTAMP', `invalid ${field}: ${JSON.stringify(value)}`);
}

export function normalizeEvent(raw) {
  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'BAD_EVENT', 'event must be an object');
  const { kind } = raw;
  need(KINDS.has(kind), 'BAD_KIND', `unknown kind: ${JSON.stringify(kind)}`);
  const eventTs = toMs(raw.eventTs, 'eventTs');
  const op = raw.op === undefined ? 'add' : raw.op;
  need(typeof op === 'string', 'BAD_EVENT', 'op must be a string');

  if (kind === 'retract') {
    const targetKind = raw.targetKind ?? raw.target;
    need(KINDS.has(targetKind) && targetKind !== 'retract', 'BAD_EVENT', 'retract needs a valid targetKind');
    need(typeof raw.id === 'string', 'BAD_EVENT', 'retract needs a string id');
    return { kind, eventTs, targetKind, id: raw.id };
  }

  need(typeof raw.id === 'string', 'BAD_EVENT', `${kind} needs a string id`);
  const base = { kind, eventTs, id: raw.id, op };

  switch (kind) {
    case 'temp': {
      need(typeof raw.zone === 'string', 'BAD_EVENT', 'temp.zone must be a string');
      need(typeof raw.c === 'number' && Number.isFinite(raw.c), 'BAD_EVENT', 'temp.c must be a number');
      if (raw.c < PHYSICAL_MIN_C || raw.c > PHYSICAL_MAX_C) {
        throw new ColdError('TEMP_RANGE', `temp ${raw.id} c=${raw.c} outside physical range [${PHYSICAL_MIN_C}, ${PHYSICAL_MAX_C}]`);
      }
      const sensor = typeof raw.sensor === 'string' ? raw.sensor : raw.zone;
      return { ...base, zone: raw.zone, c: raw.c, sensor };
    }
    case 'door': {
      need(typeof raw.zone === 'string', 'BAD_EVENT', 'door.zone must be a string');
      need(typeof raw.open === 'boolean', 'BAD_EVENT', 'door.open must be a boolean');
      return { ...base, zone: raw.zone, open: raw.open };
    }
    case 'ship': {
      need(typeof raw.lot === 'string', 'BAD_EVENT', 'ship.lot must be a string');
      need(typeof raw.zone === 'string', 'BAD_EVENT', 'ship.zone must be a string');
      const start = toMs(raw.start, 'ship.start');
      const end = toMs(raw.end, 'ship.end');
      need(start < end, 'BAD_WINDOW', `ship ${raw.id} start must be < end`);
      return { ...base, lot: raw.lot, zone: raw.zone, start, end };
    }
    case 'repair': {
      need(typeof raw.sensor === 'string', 'BAD_EVENT', 'repair.sensor must be a string');
      need(typeof raw.ok === 'boolean', 'BAD_EVENT', 'repair.ok must be a boolean');
      return { ...base, sensor: raw.sensor, ok: raw.ok };
    }
    default:
      throw new ColdError('BAD_KIND', `unknown kind: ${kind}`);
  }
}

export function processEvents(rawEvents, { watermarkLagMs = DEFAULT_WATERMARK_LAG_MS } = {}) {
  const live = new Map();
  const late = [];
  let maxTs = null;

  for (const raw of rawEvents) {
    const ev = normalizeEvent(raw);
    const watermark = maxTs === null ? null : maxTs - watermarkLagMs;
    if (watermark !== null && ev.eventTs < watermark) {
      const label = ev.kind === 'retract' ? `retract ${ev.targetKind}/${ev.id}` : `${ev.kind} ${ev.id}`;
      late.push(`${ev.eventTs} LATE ${label} (eventTs < watermark ${watermark})`);
    }
    if (maxTs === null || ev.eventTs > maxTs) maxTs = ev.eventTs;

    if (ev.kind === 'retract') {
      const key = `${ev.targetKind} ${ev.id}`;
      if (!live.delete(key)) {
        late.push(`${ev.eventTs} RETRACT_NOOP ${ev.targetKind} ${ev.id} (no live event)`);
      }
      continue;
    }
    const key = `${ev.kind} ${ev.id}`;
    if (DELETE_OPS.has(ev.op)) live.delete(key);
    else live.set(key, ev);
  }

  return {
    events: [...live.values()],
    late,
    watermark: maxTs === null ? null : maxTs - watermarkLagMs,
    maxEventTs: maxTs,
  };
}
