// History loading: JSONL of operation events plus correction events.
//
// Operation event fields:
//   invocation (id, required)  response (id, optional; missing => pending)
//   node (string)              prev (id | [ids] | null; causal predecessors)
//   realTime ([tInv, tRes] | [tInv] | t)   op, key, value
// Correction event:
//   {"op":"correct", "corrects": <invocation id>, "replacement": {...}}
// Each correction produces a new history version; older verdicts are kept
// as SUPERSEDED.

export class HistoryError extends Error {
  constructor(message, { file, line }) {
    super(message);
    this.name = 'HistoryError';
    this.file = file;
    this.line = line;
  }
}

function normalizeId(v, what, ctx) {
  if (typeof v !== 'string' && typeof v !== 'number') {
    throw new HistoryError(`${what} must be a string or number`, ctx);
  }
  return String(v);
}

function normalizeOp(obj, ctx) {
  for (const f of ['invocation', 'op', 'key']) {
    if (obj[f] === undefined || obj[f] === null) {
      throw new HistoryError(`missing required field ${JSON.stringify(f)}`, ctx);
    }
  }
  let tInv = null;
  let tRes = null;
  if (obj.realTime !== undefined && obj.realTime !== null) {
    const rt = obj.realTime;
    const pair = Array.isArray(rt) ? rt : [rt, rt];
    if (pair.length < 1 || pair.length > 2 || pair.some((t) => typeof t !== 'number')) {
      throw new HistoryError('realTime must be a number or [invocationTime, responseTime]', ctx);
    }
    tInv = pair[0];
    tRes = pair.length === 2 ? pair[1] : null;
  }
  let prev = [];
  if (obj.prev !== undefined && obj.prev !== null) {
    const list = Array.isArray(obj.prev) ? obj.prev : [obj.prev];
    prev = list.map((p) => normalizeId(p, 'prev', ctx));
  }
  return {
    kind: 'op',
    inv: normalizeId(obj.invocation, 'invocation', ctx),
    res: obj.response === undefined || obj.response === null ? null : normalizeId(obj.response, 'response', ctx),
    node: obj.node === undefined || obj.node === null ? null : String(obj.node),
    prev,
    tInv,
    tRes,
    op: String(obj.op),
    key: String(obj.key),
    value: obj.value === undefined ? null : obj.value,
    line: ctx.line,
  };
}

function normalizeEvent(obj, ctx) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new HistoryError('each line must be a JSON object', ctx);
  }
  if (obj.op === 'correct') {
    if (obj.corrects === undefined || obj.corrects === null) {
      throw new HistoryError('correction event requires "corrects"', ctx);
    }
    if (obj.replacement === undefined || obj.replacement === null) {
      throw new HistoryError('correction event requires "replacement"', ctx);
    }
    const corrects = normalizeId(obj.corrects, 'corrects', ctx);
    const raw = { ...obj.replacement };
    if (raw.invocation === undefined || raw.invocation === null) raw.invocation = corrects;
    const replacement = normalizeOp(raw, ctx);
    return {
      kind: 'correction',
      corrects,
      replacement,
      line: ctx.line,
    };
  }
  return normalizeOp(obj, ctx);
}

export function parseHistory(text, file = '<history>') {
  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const ctx = { file, line: i + 1 };
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new HistoryError(`invalid JSON: ${e.message}`, ctx);
    }
    events.push(normalizeEvent(obj, ctx));
  }
  return events;
}

// Build the sequence of history versions induced by correction events.
// Version 1 is the base history; version k+1 applies the k-th correction.
export function buildVersions(events, file = '<history>') {
  const base = [];
  const corrections = [];
  const seen = new Map();
  for (const ev of events) {
    if (ev.kind === 'correction') { corrections.push(ev); continue; }
    if (seen.has(ev.inv)) {
      throw new HistoryError(`duplicate invocation id ${JSON.stringify(ev.inv)} (first defined on line ${seen.get(ev.inv)})`, { file, line: ev.line });
    }
    seen.set(ev.inv, ev.line);
    base.push(ev);
  }
  const versions = [base];
  let current = base;
  for (const c of corrections) {
    const idx = current.findIndex((o) => o.inv === c.corrects);
    if (idx === -1) {
      throw new HistoryError(`correction targets unknown invocation ${JSON.stringify(c.corrects)}`, { file, line: c.line });
    }
    const replacement = { ...c.replacement };
    if (seen.has(replacement.inv) && replacement.inv !== c.corrects) {
      throw new HistoryError(`correction introduces duplicate invocation id ${JSON.stringify(replacement.inv)}`, { file, line: c.line });
    }
    const next = current.slice();
    next[idx] = replacement;
    seen.set(replacement.inv, c.line);
    versions.push(next);
    current = next;
  }
  return versions;
}
