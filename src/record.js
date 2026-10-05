import { MergeError } from './errors.js';

// Corrections with |delta| above this limit (degrees C) are kept but flagged
// invalid (evidence retained, hidden from default queries).
export const DELTA_LIMIT = 20;

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function checkVector(vector, ctx) {
  if (vector === undefined) return undefined;
  if (typeof vector !== 'object' || vector === null || Array.isArray(vector)) {
    throw new MergeError('BAD_RANGE', `${ctx}: vector must be an object of non-negative integers`);
  }
  const out = {};
  for (const [k, v] of Object.entries(vector)) {
    if (!Number.isInteger(v) || v < 0) {
      throw new MergeError('BAD_RANGE', `${ctx}: vector[${JSON.stringify(k)}] must be a non-negative integer`);
    }
    if (v > 0) out[k] = v;
  }
  return out;
}

function checkSite(value, ctx) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MergeError('BAD_RANGE', `${ctx}: site must be a non-empty string`);
  }
  return value;
}

function checkOriginSeq(rec, ctx) {
  if (typeof rec.origin !== 'string' || rec.origin.length === 0) {
    throw new MergeError('BAD_RANGE', `${ctx}: origin must be a non-empty string`);
  }
  if (!Number.isInteger(rec.seq) || rec.seq < 0) {
    throw new MergeError('BAD_RANGE', `${ctx}: seq must be a non-negative integer`);
  }
}

function normalizeSite(obj, ctx) {
  const site = checkSite(obj.site, ctx);
  if (obj.op !== 'register' && obj.op !== 'delete') {
    throw new MergeError('BAD_RANGE', `${ctx}: site op must be "register" or "delete"`);
  }
  checkOriginSeq(obj, ctx);
  const vector = checkVector(obj.vector ?? { [obj.origin]: obj.seq }, ctx);
  return { type: 'site', site, op: obj.op, origin: obj.origin, seq: obj.seq, vector };
}

function normalizeCorrection(obj, ctx) {
  const site = checkSite(obj.site, ctx);
  const ms = Date.parse(obj.time);
  if (typeof obj.time !== 'string' || Number.isNaN(ms)) {
    throw new MergeError('BAD_RANGE', `${ctx}: time must be a valid timestamp, got ${JSON.stringify(obj.time)}`);
  }
  if (typeof obj.delta !== 'number' || !Number.isFinite(obj.delta)) {
    throw new MergeError('BAD_RANGE', `${ctx}: delta must be a finite number, got ${JSON.stringify(obj.delta)}`);
  }
  checkOriginSeq(obj, ctx);
  const vector = checkVector(obj.vector ?? { [obj.origin]: obj.seq }, ctx);
  return {
    type: 'correction',
    site,
    time: new Date(ms).toISOString(),
    delta: obj.delta,
    invalid: Math.abs(obj.delta) > DELTA_LIMIT,
    origin: obj.origin,
    seq: obj.seq,
    vector,
  };
}

function normalizeFrontier(obj, ctx) {
  if (typeof obj.origin !== 'string' || obj.origin.length === 0) {
    throw new MergeError('BAD_RANGE', `${ctx}: origin must be a non-empty string`);
  }
  const vector = checkVector(obj.vector, ctx) ?? {};
  return { type: 'frontier', origin: obj.origin, vector };
}

export function normalizeRecord(obj, ctx = 'record') {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new MergeError('BAD_RANGE', `${ctx}: expected a JSON object`);
  }
  switch (obj.type) {
    case 'site': return normalizeSite(obj, ctx);
    case 'correction': return normalizeCorrection(obj, ctx);
    case 'frontier': return normalizeFrontier(obj, ctx);
    default:
      throw new MergeError('BAD_RANGE', `${ctx}: unknown record type ${JSON.stringify(obj.type)}`);
  }
}

export function parseJsonl(text, source = '<input>') {
  const records = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new MergeError('BAD_RANGE', `${source}:${i + 1}: invalid JSON`);
    }
    records.push(normalizeRecord(obj, `${source}:${i + 1}`));
  }
  return records;
}

// Identity used to deduplicate the same logical record arriving repeatedly.
export function dedupId(rec) {
  switch (rec.type) {
    case 'site': return `site|${rec.site}|${rec.origin}|${rec.seq}`;
    case 'correction': return `correction|${rec.site}|${rec.time}|${rec.origin}|${rec.seq}`;
    case 'frontier': return `frontier|${rec.origin}`;
    default: throw new Error(`unknown type ${rec.type}`);
  }
}

// Grouping key: winner determination happens per key.
export function keyOf(rec) {
  switch (rec.type) {
    case 'site': return `site|${rec.site}`;
    case 'correction': return `correction|${rec.site}|${rec.time}`;
    default: return null;
  }
}
