// Event parsing / normalization. Input lines are JSON objects with a `kind`
// discriminator. Timestamps accept epoch ms (number) or ISO-8601 strings and
// are normalized to epoch ms.

export class EventError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function toMs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new EventError('TS_INVALID', `invalid eventTs: ${JSON.stringify(ts)}`);
}

function need(obj, fields, kind) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null) {
      throw new EventError('FIELD_MISSING', `${kind}: missing field ${f}`);
    }
  }
}

export function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EventError('EVENT_INVALID', 'event must be a JSON object');
  }
  const kind = raw.kind ?? raw.type;
  if (typeof kind !== 'string') {
    throw new EventError('KIND_MISSING', 'event missing kind');
  }
  switch (kind) {
    case 'fill': {
      need(raw, ['eventTs', 'batch', 'vol', 'weight', 'op'], kind);
      return {
        kind, eventTs: toMs(raw.eventTs), batch: String(raw.batch),
        vol: Number(raw.vol), weight: Number(raw.weight), op: String(raw.op),
      };
    }
    case 'cip': {
      need(raw, ['eventTs', 'line', 'start', 'end', 'ok', 'op'], kind);
      return {
        kind, eventTs: toMs(raw.eventTs), line: String(raw.line),
        start: toMs(raw.start), end: toMs(raw.end),
        ok: Boolean(raw.ok), op: String(raw.op),
      };
    }
    case 'lab': {
      need(raw, ['eventTs', 'batch', 'pass', 'op'], kind);
      return {
        kind, eventTs: toMs(raw.eventTs), batch: String(raw.batch),
        pass: Boolean(raw.pass), op: String(raw.op),
      };
    }
    case 'retract': {
      need(raw, ['eventTs', 'id'], kind);
      const target = raw.target ?? raw.retractKind;
      if (!['fill', 'cip', 'lab'].includes(target)) {
        throw new EventError('TARGET_INVALID', `retract: bad target ${JSON.stringify(raw.target)}`);
      }
      return { kind, eventTs: toMs(raw.eventTs), target, id: String(raw.id) };
    }
    default:
      throw new EventError('KIND_UNKNOWN', `unknown kind: ${kind}`);
  }
}
