// History JSONL parsing and correction handling.
//
// Each line is either an operation event:
//   {"id","node","prev","invocation","response","realTime","op","key","value"}
// or a correction event (distinguished by the "corrects" field):
//   {"id","corrects","realTime","op","key","value"}
// A correction replaces the target event's op/key/value and produces a new
// history version; earlier versions keep their verdicts as SUPERSEDED.

export class HistoryError extends Error {
  constructor(line, message) {
    super(`line ${line}: ${message}`);
    this.name = 'HistoryError';
    this.line = line;
    this.isHistoryError = true;
  }
}

function need(obj, field, line, type) {
  if (!(field in obj)) throw new HistoryError(line, `missing required field "${field}"`);
  const v = obj[field];
  if (type === 'string' && typeof v !== 'string') throw new HistoryError(line, `field "${field}" must be a string`);
  if (type === 'number' && (typeof v !== 'number' || Number.isNaN(v))) throw new HistoryError(line, `field "${field}" must be a number`);
  return v;
}

function parseEvent(obj, line) {
  const id = need(obj, 'id', line, 'string');
  const node = need(obj, 'node', line, 'string');
  const invocation = need(obj, 'invocation', line, 'number');
  const realTime = need(obj, 'realTime', line, 'number');
  const op = need(obj, 'op', line, 'string');
  const key = need(obj, 'key', line, 'string');
  if (!('value' in obj)) throw new HistoryError(line, 'missing required field "value"');
  let response = null;
  if ('response' in obj && obj.response !== null) {
    if (typeof obj.response !== 'number' || Number.isNaN(obj.response)) {
      throw new HistoryError(line, 'field "response" must be a number or null');
    }
    response = obj.response;
  }
  let prev = null;
  if ('prev' in obj && obj.prev !== null) {
    if (typeof obj.prev !== 'string') throw new HistoryError(line, 'field "prev" must be a string or null');
    prev = obj.prev;
  }
  return { id, node, prev, invocation, response, realTime, op, key, value: obj.value, line };
}

function parseCorrection(obj, line) {
  const id = need(obj, 'id', line, 'string');
  const corrects = need(obj, 'corrects', line, 'string');
  const realTime = need(obj, 'realTime', line, 'number');
  const op = need(obj, 'op', line, 'string');
  const key = need(obj, 'key', line, 'string');
  if (!('value' in obj)) throw new HistoryError(line, 'missing required field "value"');
  return { id, corrects, realTime, op, key, value: obj.value, line };
}

export function parseHistory(text) {
  const events = [];
  const corrections = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const s = raw.trim();
    if (s === '') return;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      throw new HistoryError(lineNo, 'invalid JSON');
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new HistoryError(lineNo, 'each line must be a JSON object');
    }
    if ('corrects' in obj) corrections.push(parseCorrection(obj, lineNo));
    else events.push(parseEvent(obj, lineNo));
  });
  const seen = new Set();
  for (const e of events) {
    if (seen.has(e.id)) throw new HistoryError(e.line, `duplicate event id "${e.id}"`);
    seen.add(e.id);
  }
  for (const c of corrections) {
    if (seen.has(c.id)) throw new HistoryError(c.line, `duplicate event id "${c.id}"`);
    seen.add(c.id);
  }
  return { events, corrections };
}

// Build the version chain: version 1 is the base history; each correction
// (applied in realTime order, ties by id) produces a new version.
export function buildVersions({ events, corrections }) {
  const sorted = corrections.slice().sort((a, b) =>
    a.realTime - b.realTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const versions = [{ events: events.map((e) => ({ ...e })), correction: null, missingTarget: false }];
  let current = versions[0].events;
  for (const c of sorted) {
    const next = current.map((e) => ({ ...e }));
    const target = next.find((e) => e.id === c.corrects);
    const version = { events: next, correction: c, missingTarget: !target };
    if (target) {
      target.op = c.op;
      target.key = c.key;
      target.value = c.value;
      target.correctedBy = c.id;
    }
    versions.push(version);
    current = next;
  }
  return versions;
}
