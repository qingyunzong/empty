// Event parsing & validation. Input is JSONL; timestamps may be epoch ms or ISO-8601.

export const KINDS = new Set(['fill', 'cip', 'lab']);

export function toTs(v, ctx) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  throw new Error(`${ctx}: invalid timestamp ${JSON.stringify(v)}`);
}

function need(raw, field, ctx) {
  if (raw[field] === undefined || raw[field] === null) {
    throw new Error(`${ctx}: missing field "${field}"`);
  }
  return raw[field];
}

function needNum(raw, field, ctx) {
  const v = need(raw, field, ctx);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${ctx}: field "${field}" must be a finite number`);
  }
  return v;
}

function needStr(raw, field, ctx) {
  const v = need(raw, field, ctx);
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${ctx}: field "${field}" must be a non-empty string`);
  }
  return v;
}

function needBool(raw, field, ctx) {
  const v = need(raw, field, ctx);
  if (typeof v !== 'boolean') {
    throw new Error(`${ctx}: field "${field}" must be a boolean`);
  }
  return v;
}

export function parseEvent(line, ctx = 'input') {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch (e) {
    throw new Error(`${ctx}: invalid JSON: ${e.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${ctx}: event must be a JSON object`);
  }
  const type = needStr(raw, 'type', ctx);
  const eventTs = toTs(need(raw, 'eventTs', ctx), ctx);
  switch (type) {
    case 'fill':
      return {
        type, eventTs,
        batch: needStr(raw, 'batch', ctx),
        vol: needNum(raw, 'vol', ctx),
        weight: needNum(raw, 'weight', ctx),
        op: needStr(raw, 'op', ctx),
      };
    case 'cip':
      return {
        type, eventTs,
        line: needStr(raw, 'line', ctx),
        start: toTs(need(raw, 'start', ctx), ctx),
        end: toTs(need(raw, 'end', ctx), ctx),
        ok: needBool(raw, 'ok', ctx),
        op: needStr(raw, 'op', ctx),
      };
    case 'lab':
      return {
        type, eventTs,
        batch: needStr(raw, 'batch', ctx),
        pass: needBool(raw, 'pass', ctx),
        op: needStr(raw, 'op', ctx),
      };
    case 'retract': {
      const kind = needStr(raw, 'kind', ctx);
      if (!KINDS.has(kind)) {
        throw new Error(`${ctx}: retract kind must be one of fill|cip|lab, got ${JSON.stringify(kind)}`);
      }
      return { type, eventTs, kind, id: needStr(raw, 'id', ctx) };
    }
    default:
      throw new Error(`${ctx}: unknown event type ${JSON.stringify(type)}`);
  }
}
