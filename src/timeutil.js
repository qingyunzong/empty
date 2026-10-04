import { RecallError } from './intervals.js';

const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/;

export function parseLocal(str) {
  if (typeof str !== 'string') throw new RecallError('INVALID_TIME', `invalid local time: ${str}`);
  const ms = Date.parse(OFFSET_RE.test(str) ? str : `${str}Z`);
  if (Number.isNaN(ms)) throw new RecallError('INVALID_TIME', `invalid local time: ${str}`);
  return ms;
}

export function parseUtc(str) {
  if (typeof str !== 'string') throw new RecallError('INVALID_TIME', `invalid UTC time: ${str}`);
  const ms = Date.parse(str);
  if (Number.isNaN(ms)) throw new RecallError('INVALID_TIME', `invalid UTC time: ${str}`);
  return ms;
}

export function fmt(ms) {
  return new Date(ms).toISOString();
}

export class ConversionTable {
  constructor(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new RecallError('EMPTY_CONVERSION', 'conversion table must contain at least one entry');
    }
    this.anchors = entries
      .map((e) => ({ local: parseLocal(e.local), utc: parseUtc(e.utc) }))
      .sort((a, b) => a.local - b.local);
  }

  toUtc(localMs) {
    let chosen = this.anchors[0];
    for (const anchor of this.anchors) {
      if (anchor.local <= localMs) chosen = anchor;
      else break;
    }
    return localMs + (chosen.utc - chosen.local);
  }
}
