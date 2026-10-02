'use strict';

const TYPES = new Set(['ASSIGN', 'PICK', 'DROP', 'FAIL', 'RETRY']);
const TYPE_RANK = { ASSIGN: 0, PICK: 1, DROP: 2, FAIL: 3, RETRY: 4 };

function parseFrames(text) {
  const events = [];
  let buf = '';
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim() && !buf) continue;
    buf += (buf ? '\n' : '') + line;
    try {
      events.push(JSON.parse(buf));
      buf = '';
    } catch {
      // fragmented frame: keep accumulating until the JSON completes
    }
  }
  if (buf.trim()) {
    throw new Error('unterminated JSON frame: ' + buf.slice(0, 80));
  }
  return events;
}

function normalizeCause(raw) {
  if (typeof raw === 'string') {
    const i = raw.lastIndexOf(':');
    if (i <= 0) throw new Error('invalid cause string: ' + JSON.stringify(raw));
    return checkCause({ job: raw.slice(0, i), leg: Number(raw.slice(i + 1)) });
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return checkCause({ job: raw.job, leg: raw.leg });
  }
  throw new Error('invalid cause: ' + JSON.stringify(raw));
}

function checkCause(c) {
  checkJob(c.job);
  if (!Number.isInteger(c.leg) || c.leg < 0) {
    throw new Error('invalid cause leg: ' + JSON.stringify(c.leg));
  }
  return c;
}

function checkJob(job) {
  if (typeof job !== 'string' || job.length === 0 || /[\s#>]/.test(job)) {
    throw new Error('invalid job id: ' + JSON.stringify(job));
  }
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('event must be an object, got: ' + JSON.stringify(raw));
  }
  const { type, job, leg, seq, ts } = raw;
  if (!TYPES.has(type)) throw new Error('unknown event type: ' + JSON.stringify(type));
  checkJob(job);
  if (!Number.isInteger(leg) || leg < 0) throw new Error('invalid leg: ' + JSON.stringify(leg));
  if (!Number.isInteger(seq) || seq < 0) throw new Error('invalid seq: ' + JSON.stringify(seq));
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) {
    throw new Error('invalid ts: ' + JSON.stringify(ts));
  }
  const rawCauses = raw.causes == null ? [] : raw.causes;
  if (!Array.isArray(rawCauses)) throw new Error('causes must be an array');
  const causes = rawCauses.map(normalizeCause);
  return { type, job, leg, seq, causes, ts };
}

function eventKey(e) {
  const cs = e.causes.map((c) => c.job + ':' + c.leg).sort();
  return JSON.stringify([e.type, e.job, e.leg, e.seq, e.ts, cs]);
}

module.exports = { TYPES, TYPE_RANK, parseFrames, normalizeEvent, eventKey };
