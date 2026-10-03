// Input parsing and validation. All domain errors carry an exitCode so the
// CLI can map them to the required process exit statuses.

import { parseDate, toDays } from './dates.js';

export const EXIT_INVALID_DATE = 25;
export const EXIT_UNTRUSTED_INSTITUTION = 26;
export const EXIT_RESTORE_SELF_REFERENCE = 27;

export class InputError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = 'InputError';
    this.exitCode = exitCode;
  }
}

export function requireDate(value, context) {
  const parsed = parseDate(value);
  if (parsed === null) {
    throw new InputError(EXIT_INVALID_DATE, `invalid date ${JSON.stringify(value)} (${context})`);
  }
  return toDays(parsed);
}

function parseJsonLines(text, source) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch (e) {
      throw new InputError(1, `${source}:${i + 1}: ${e.message}`);
    }
  }
  return out;
}

export function parseInstruments(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new InputError(1, `instruments.json: ${e.message}`);
  }
  const trusted = new Set(doc.trusted_institutions ?? []);
  const types = new Map();
  for (const [name, t] of Object.entries(doc.instrument_types ?? {})) {
    if (!Number.isInteger(t.calibration_interval_months) || t.calibration_interval_months <= 0) {
      throw new InputError(1, `instrument type ${name}: bad calibration_interval_months`);
    }
    types.set(name, { name, intervalMonths: t.calibration_interval_months });
  }
  const instruments = new Map();
  for (const inst of doc.instruments ?? []) {
    if (!types.has(inst.type)) {
      throw new InputError(1, `instrument ${inst.id}: unknown type ${inst.type}`);
    }
    if (instruments.has(inst.id)) {
      throw new InputError(1, `duplicate instrument ${inst.id}`);
    }
    instruments.set(inst.id, { id: inst.id, type: inst.type });
  }
  return { trusted, types, instruments };
}

// Raw calibration events; semantic validation happens in buildState().
export function parseCalibrations(text) {
  return parseJsonLines(text, 'calibrations.jsonl');
}

export function parseUsage(text) {
  const records = [];
  for (const [i, u] of parseJsonLines(text, 'usage.jsonl').entries()) {
    if (typeof u.work_order !== 'string' || typeof u.instrument !== 'string') {
      throw new InputError(1, `usage.jsonl:${i + 1}: missing work_order/instrument`);
    }
    records.push({
      work_order: u.work_order,
      measurement: u.measurement ?? `line-${i + 1}`,
      instrument: u.instrument,
      date: requireDate(u.date, `usage.jsonl:${i + 1}`),
      dateText: u.date,
    });
  }
  return records;
}
