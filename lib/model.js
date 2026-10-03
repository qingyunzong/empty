import { MetrologyError, EXIT, validation } from './errors.js';
import { isValidDateString, addDays, compareDates } from './dates.js';

const KIND_ORDER = { certificate: 0, revocation: 1, reinstatement: 2 };

function requireDate(value, context) {
  if (!isValidDateString(value)) {
    throw new MetrologyError(`invalid date ${JSON.stringify(value)} in ${context}`, EXIT.INVALID_DATE);
  }
  return value;
}

function requireString(value, context, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw validation(`${context}: field "${field}" must be a non-empty string`);
  }
  return value;
}

export function loadInstruments(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw validation('instruments.json must be a JSON object');
  }
  const trusted = data.trustedInstitutions;
  if (!Array.isArray(trusted) || trusted.some((t) => typeof t !== 'string')) {
    throw validation('instruments.json: trustedInstitutions must be an array of strings');
  }
  const types = new Map();
  for (const [name, def] of Object.entries(data.types ?? {})) {
    const interval = def?.calibrationIntervalDays;
    if (!Number.isInteger(interval) || interval <= 0) {
      throw validation(`type "${name}": calibrationIntervalDays must be a positive integer`);
    }
    types.set(name, { name, calibrationIntervalDays: interval });
  }
  const instruments = new Map();
  for (const inst of data.instruments ?? []) {
    requireString(inst?.id, 'instruments.json', 'id');
    requireString(inst?.type, `instrument ${inst.id}`, 'type');
    if (!types.has(inst.type)) {
      throw validation(`instrument ${inst.id}: unknown type "${inst.type}"`);
    }
    if (instruments.has(inst.id)) {
      throw validation(`duplicate instrument id "${inst.id}"`);
    }
    instruments.set(inst.id, { id: inst.id, type: inst.type });
  }
  return { trustedInstitutions: new Set(trusted), types, instruments };
}

export function loadCalibrations(text, model) {
  const certificates = new Map();
  const events = [];
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  lines.forEach((line, index) => {
    const ctx = `calibrations.jsonl line ${index + 1}`;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      throw validation(`${ctx}: invalid JSON`);
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw validation(`${ctx}: entry must be a JSON object`);
    }
    if (raw.kind === 'certificate') {
      requireDate(raw.date, ctx);
      requireString(raw.id, ctx, 'id');
      requireString(raw.instrument, ctx, 'instrument');
      requireString(raw.institution, ctx, 'institution');
      if (!model.instruments.has(raw.instrument)) {
        throw validation(`${ctx}: unknown instrument "${raw.instrument}"`);
      }
      if (!model.trustedInstitutions.has(raw.institution)) {
        throw new MetrologyError(`${ctx}: untrusted institution "${raw.institution}"`, EXIT.UNTRUSTED_INSTITUTION);
      }
      const level = raw.level ?? 1;
      if (!Number.isInteger(level) || level < 1) {
        throw validation(`${ctx}: level must be a positive integer`);
      }
      if (raw.intervalDays !== undefined && (!Number.isInteger(raw.intervalDays) || raw.intervalDays <= 0)) {
        throw validation(`${ctx}: intervalDays must be a positive integer`);
      }
      if (certificates.has(raw.id)) {
        throw validation(`${ctx}: duplicate certificate id "${raw.id}"`);
      }
      // Individual certificate interval overrides the type interval.
      const intervalDays = raw.intervalDays
        ?? model.types.get(model.instruments.get(raw.instrument).type).calibrationIntervalDays;
      const cert = {
        id: raw.id,
        instrument: raw.instrument,
        institution: raw.institution,
        level,
        date: raw.date,
        intervalDays,
        expiry: addDays(raw.date, intervalDays),
        segments: [],
        active: false,
        currentStart: null,
        lastRevokedAt: null,
      };
      certificates.set(cert.id, cert);
      events.push({ kind: 'certificate', date: raw.date, cert });
    } else if (raw.kind === 'revocation') {
      requireDate(raw.date, ctx);
      requireString(raw.certificate, ctx, 'certificate');
      events.push({ kind: 'revocation', date: raw.date, certificateId: raw.certificate });
    } else if (raw.kind === 'reinstatement') {
      requireDate(raw.date, ctx);
      requireString(raw.certificate, ctx, 'certificate');
      requireString(raw.reinstates, ctx, 'reinstates');
      events.push({ kind: 'reinstatement', date: raw.date, certificateId: raw.certificate, reinstatesId: raw.reinstates });
    } else {
      throw validation(`${ctx}: unknown kind ${JSON.stringify(raw.kind)}`);
    }
  });

  for (const ev of events) {
    if (ev.kind === 'revocation') {
      ev.cert = certificates.get(ev.certificateId);
      if (!ev.cert) throw validation(`revocation of unknown certificate "${ev.certificateId}"`);
    } else if (ev.kind === 'reinstatement') {
      ev.by = certificates.get(ev.certificateId);
      ev.target = certificates.get(ev.reinstatesId);
      if (!ev.by) throw validation(`reinstatement by unknown certificate "${ev.certificateId}"`);
      if (!ev.target) throw validation(`reinstatement of unknown certificate "${ev.reinstatesId}"`);
    }
  }
  checkReinstatementLinks(events);

  events.sort((a, b) =>
    compareDates(a.date, b.date)
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || (a.cert?.id ?? '').localeCompare(b.cert?.id ?? ''));

  replay(events, certificates);
  return { certificates, events };
}

function checkReinstatementLinks(events) {
  const edges = new Map();
  for (const ev of events) {
    if (ev.kind !== 'reinstatement') continue;
    const { by, target } = ev;
    if (by.id === target.id) {
      throw new MetrologyError(`reinstatement chain self-reference at certificate "${by.id}"`, EXIT.REINSTATEMENT_CYCLE);
    }
    if (by.instrument !== target.instrument) {
      throw validation(`reinstating certificate "${by.id}" must belong to instrument "${target.instrument}"`);
    }
    if (by.institution !== target.institution) {
      throw validation(`reinstating certificate "${by.id}" must come from institution "${target.institution}"`);
    }
    if (by.level <= target.level) {
      throw validation(`reinstating certificate "${by.id}" (level ${by.level}) must outrank "${target.id}" (level ${target.level})`);
    }
    if (edges.has(by.id)) {
      throw validation(`certificate "${by.id}" reinstates more than one certificate`);
    }
    edges.set(by.id, target.id);
  }
  for (const start of edges.keys()) {
    let current = start;
    const seen = new Set([start]);
    while (edges.has(current)) {
      current = edges.get(current);
      if (seen.has(current)) {
        throw new MetrologyError(`reinstatement chain cycle involving certificate "${current}"`, EXIT.REINSTATEMENT_CYCLE);
      }
      seen.add(current);
    }
  }
}

function replay(events, certificates) {
  for (const ev of events) {
    if (ev.kind === 'certificate') {
      ev.cert.active = true;
      ev.cert.currentStart = ev.date;
    } else if (ev.kind === 'revocation') {
      const cert = ev.cert;
      if (!cert.active) {
        throw validation(`certificate "${cert.id}" is not active at revocation ${ev.date}`);
      }
      if (compareDates(ev.date, cert.currentStart) < 0) {
        throw validation(`revocation of "${cert.id}" (${ev.date}) predates its current validity segment`);
      }
      // Earlier invalidation point wins: the segment ends at the earlier of
      // the revocation date and the natural expiry. A revocation at or after
      // expiry is a no-op and does not taint past measurements.
      const tainted = compareDates(ev.date, cert.expiry) < 0;
      const end = tainted ? ev.date : cert.expiry;
      cert.segments.push({ certId: cert.id, start: cert.currentStart, end, tainted, revokedAt: tainted ? ev.date : null });
      cert.active = false;
      cert.currentStart = null;
      cert.lastRevokedAt = ev.date;
    } else {
      const { by, target, date } = ev;
      if (target.active) {
        throw validation(`certificate "${target.id}" is not revoked at reinstatement ${date}`);
      }
      if (compareDates(date, target.lastRevokedAt) < 0) {
        throw validation(`reinstatement of "${target.id}" (${date}) predates its revocation`);
      }
      if (compareDates(date, target.expiry) >= 0) {
        throw validation(`certificate "${target.id}" already expired at reinstatement ${date}`);
      }
      if (!by.active || compareDates(by.currentStart, date) > 0 || compareDates(date, by.expiry) >= 0) {
        throw validation(`reinstating certificate "${by.id}" is not itself valid at ${date}`);
      }
      target.active = true;
      target.currentStart = date;
    }
  }
  for (const cert of certificates.values()) {
    if (cert.active) {
      cert.segments.push({ certId: cert.id, start: cert.currentStart, end: cert.expiry, tainted: false, revokedAt: null });
      cert.active = false;
      cert.currentStart = null;
    }
  }
}

export function loadUsage(text, model) {
  const usages = [];
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  lines.forEach((line, index) => {
    const ctx = `usage.jsonl line ${index + 1}`;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      throw validation(`${ctx}: invalid JSON`);
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw validation(`${ctx}: entry must be a JSON object`);
    }
    requireDate(raw.date, ctx);
    requireString(raw.workOrder, ctx, 'workOrder');
    requireString(raw.instrument, ctx, 'instrument');
    if (!model.instruments.has(raw.instrument)) {
      throw validation(`${ctx}: unknown instrument "${raw.instrument}"`);
    }
    const result = raw.result ?? 'pass';
    if (result !== 'pass' && result !== 'fail') {
      throw validation(`${ctx}: result must be "pass" or "fail"`);
    }
    usages.push({ workOrder: raw.workOrder, instrument: raw.instrument, date: raw.date, result });
  });
  return usages;
}
