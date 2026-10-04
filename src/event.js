import { validation } from './errors.js';

export const KINDS = new Set([
  'quality.hold',    // manual or auto (payload.auto=true) quality hold on a lot
  'quality.release', // manual release of a held lot
  'quality.scan',    // QC scan; payload.result 'fail' implies auto-hold
  'device.alarm',    // PLC alarm raised
  'device.clear',    // PLC alarm cleared
]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateEvent(e, lineNo) {
  const at = lineNo !== undefined ? `line ${lineNo}` : 'event';
  if (!isObj(e)) throw validation(`${at}: event must be an object`);
  if (typeof e.id !== 'string' || e.id.length === 0) throw validation(`${at}: id must be a non-empty string`, { event: e });
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) throw validation(`${at}: ts must be a finite number`, { id: e.id });
  if (typeof e.device !== 'string' || e.device.length === 0) throw validation(`${at}: device must be a non-empty string`, { id: e.id });
  if (typeof e.lot !== 'string' || e.lot.length === 0) throw validation(`${at}: lot must be a non-empty string`, { id: e.id });
  if (!KINDS.has(e.kind)) throw validation(`${at}: unknown kind ${JSON.stringify(e.kind)}`, { id: e.id });
  if (e.payload !== undefined && !isObj(e.payload)) throw validation(`${at}: payload must be an object`, { id: e.id });
  const deps = e.payload?.deps;
  if (deps !== undefined && (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string'))) {
    throw validation(`${at}: payload.deps must be an array of event ids`, { id: e.id });
  }
  return e;
}

export function parseJsonl(text) {
  const events = [];
  const errors = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      errors.push({ code: 'VALIDATION', message: `line ${i + 1}: invalid JSON` });
      continue;
    }
    try {
      events.push(validateEvent(obj, i + 1));
    } catch (err) {
      errors.push({ code: 'VALIDATION', message: err.message, details: err.details ?? null });
    }
  }
  return { events, errors };
}

// Deterministic application order: timestamp, then id.
export function byTsId(a, b) {
  return a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
