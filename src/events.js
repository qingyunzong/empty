// Input parsing and validation for JSONL event lines.
//
// Supported event shapes:
//   {"type":"sensor","id":"s1","eventTs":0,"tag":"pressure","value":1200,"unit":"kPa","seq":0,"op":"add"}
//   {"type":"trip","id":"tr1","eventTs":4000,"channel":"PT-1","state":"TRIPPED","op":"add"}
//   {"type":"retract","eventTs":7000,"kind":"sensor","id":"s1"}
//
// `op` defaults to "add"; op:"retract" on a sensor/trip is sugar for a retract
// of that event itself. Retract events get a deterministic id derived from
// (kind, target id) so duplicate retracts are idempotent.

function diag(code, extra) {
  return { diagnostic: { code, ...extra } };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseTs(value) {
  return isFiniteNumber(value) && value >= 0 ? value : null;
}

function parseOp(rawOp, kind, id, ts) {
  const op = rawOp === undefined ? 'add' : rawOp;
  if (op === 'add') return { op };
  if (op === 'retract') {
    return {
      event: {
        kind: 'retract',
        id: `retract:${kind}:${id}`,
        ts,
        targetKind: kind,
        targetId: String(id),
      },
    };
  }
  return null;
}

export function parseEventLine(line, config) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return diag('BAD_JSON', {});
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return diag('BAD_EVENT', { reason: 'not an object' });
  }

  if (obj.type === 'sensor') {
    if (obj.id === undefined || obj.id === null) return diag('BAD_EVENT', { reason: 'sensor missing id' });
    const ts = parseTs(obj.eventTs);
    if (ts === null) return diag('BAD_EVENT', { reason: 'sensor bad eventTs', id: String(obj.id) });
    const id = String(obj.id);
    const opResult = parseOp(obj.op, 'sensor', id, ts);
    if (opResult === null) return diag('BAD_EVENT', { reason: 'bad op', id });
    if (opResult.event) return opResult;

    let mappedTag = null;
    if (obj.tag === config.pressureTag) mappedTag = 'pressure';
    else if (obj.tag === config.tempTag) mappedTag = 'temperature';
    else return { ignored: true };

    if (!isFiniteNumber(obj.value)) return diag('BAD_EVENT', { reason: 'sensor bad value', id });
    const expectedUnit = mappedTag === 'pressure' ? config.pressureUnit : config.tempUnit;
    if (obj.unit === undefined || obj.unit === null) {
      return diag('UNIT_MISSING', { id, tag: obj.tag, ts });
    }
    if (obj.unit !== expectedUnit) {
      return diag('UNIT_MISMATCH', { id, tag: obj.tag, ts, unit: obj.unit, expected: expectedUnit });
    }
    const seq = Number.isInteger(obj.seq) ? obj.seq : 0;
    return { event: { kind: 'sensor', id, ts, tag: mappedTag, value: obj.value, seq } };
  }

  if (obj.type === 'trip') {
    if (obj.id === undefined || obj.id === null) return diag('BAD_EVENT', { reason: 'trip missing id' });
    const ts = parseTs(obj.eventTs);
    if (ts === null) return diag('BAD_EVENT', { reason: 'trip bad eventTs', id: String(obj.id) });
    const id = String(obj.id);
    const opResult = parseOp(obj.op, 'trip', id, ts);
    if (opResult === null) return diag('BAD_EVENT', { reason: 'bad op', id });
    if (opResult.event) return opResult;
    if (obj.state !== 'TRIPPED' && obj.state !== 'RESET') {
      return diag('BAD_EVENT', { reason: 'trip bad state', id });
    }
    const channel = typeof obj.channel === 'string' ? obj.channel : 'default';
    return { event: { kind: 'trip', id, ts, channel, state: obj.state } };
  }

  if (obj.type === 'retract') {
    const ts = parseTs(obj.eventTs);
    if (ts === null) return diag('BAD_EVENT', { reason: 'retract bad eventTs' });
    if (obj.kind !== 'sensor' && obj.kind !== 'trip') {
      return diag('BAD_EVENT', { reason: 'retract bad kind' });
    }
    if (obj.id === undefined || obj.id === null) return diag('BAD_EVENT', { reason: 'retract missing target id' });
    const targetId = String(obj.id);
    return {
      event: {
        kind: 'retract',
        id: `retract:${obj.kind}:${targetId}`,
        ts,
        targetKind: obj.kind,
        targetId,
      },
    };
  }

  return diag('BAD_EVENT', { reason: `unknown type ${String(obj.type)}` });
}
