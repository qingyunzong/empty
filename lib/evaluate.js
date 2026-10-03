import { compareDates } from './dates.js';
import { MetrologyError, EXIT } from './errors.js';

export function coveringCertificates(certificates, instrumentId, date) {
  const out = [];
  for (const cert of certificates.values()) {
    if (cert.instrument !== instrumentId) continue;
    for (const segment of cert.segments) {
      if (compareDates(segment.start, date) <= 0 && compareDates(date, segment.end) < 0) {
        out.push({ cert, segment });
      }
    }
  }
  return out;
}

export function isUsable(certificates, instrumentId, date) {
  return coveringCertificates(certificates, instrumentId, date).length > 0;
}

function pickRelied(candidates) {
  return [...candidates].sort((a, b) =>
    Number(a.segment.tainted) - Number(b.segment.tainted)
    || compareDates(b.cert.date, a.cert.date)
    || a.cert.id.localeCompare(b.cert.id))[0];
}

export function evaluateUsage(certificates, usage) {
  const candidates = coveringCertificates(certificates, usage.instrument, usage.date);
  const relied = candidates.length > 0 ? pickRelied(candidates) : null;
  let legality;
  if (candidates.some((c) => !c.segment.tainted)) legality = 'valid';
  else if (candidates.length > 0) legality = 'pending_retest';
  else legality = 'illegal';
  const status = usage.result === 'pass' ? legality : 'failed';
  return {
    ...usage,
    status,
    legality,
    certificate: relied ? relied.cert.id : null,
    revokedAt: relied ? relied.segment.revokedAt : null,
  };
}

export function instrumentStatus(model, certificates, instrumentId, asOf) {
  const inst = model.instruments.get(instrumentId);
  const candidates = coveringCertificates(certificates, instrumentId, asOf);
  const relied = candidates.length > 0 ? pickRelied(candidates) : null;
  return {
    id: instrumentId,
    type: inst.type,
    usable: candidates.length > 0,
    certificate: relied ? relied.cert.id : null,
    expiresOn: relied ? relied.segment.end : null,
    tainted: relied ? relied.segment.tainted : null,
  };
}

export function buildStatus(model, certificates, asOf) {
  const instruments = [...model.instruments.keys()].sort()
    .map((id) => instrumentStatus(model, certificates, id, asOf));
  return {
    asOf,
    instruments,
    usableInstruments: instruments.filter((i) => i.usable).map((i) => i.id),
    unusableInstruments: instruments.filter((i) => !i.usable).map((i) => i.id),
  };
}

export function buildImpact(evaluated) {
  return evaluated
    .filter((u) => u.status === 'pending_retest' || u.status === 'illegal')
    .map((u) => ({
      workOrder: u.workOrder,
      instrument: u.instrument,
      date: u.date,
      result: u.result,
      status: u.status,
      certificate: u.certificate,
      reason: u.status === 'pending_retest' ? 'certificate_revoked' : 'no_valid_certificate',
      ...(u.revokedAt ? { revokedAt: u.revokedAt } : {}),
    }))
    .sort((a, b) =>
      a.workOrder.localeCompare(b.workOrder)
      || compareDates(a.date, b.date)
      || a.instrument.localeCompare(b.instrument));
}

// Minimal counterexample: the smallest set of certificates whose revocation at
// `revokeAt` turns the work order from legal into illegal. A revocation at T
// removes all coverage the certificate provides on dates >= T, so only usage
// dates on/after T can be made illegal; for such a date d, every certificate
// covering d must be revoked. The minimum is therefore the smallest set of
// certificates covering any single usage date >= T.
export function minimalRevocations(certificates, usages, workOrder, revokeAt) {
  const wo = usages.filter((u) => u.workOrder === workOrder);
  if (wo.length === 0) {
    throw new MetrologyError(`unknown work order "${workOrder}"`, EXIT.VALIDATION);
  }
  const evaluated = wo.map((u) => evaluateUsage(certificates, u));
  if (evaluated.some((u) => u.legality === 'illegal')) {
    return { workOrder, legal: false, revokeAt, minimalRevocations: { count: 0, certificates: [] } };
  }
  let best = null;
  for (const usage of wo) {
    if (compareDates(usage.date, revokeAt) < 0) continue;
    const ids = [...new Set(coveringCertificates(certificates, usage.instrument, usage.date).map((c) => c.cert.id))].sort();
    if (ids.length === 0) continue;
    if (best === null || ids.length < best.length
      || (ids.length === best.length && ids.join('') < best.join(''))) {
      best = ids;
    }
  }
  if (best === null) {
    return {
      workOrder,
      legal: true,
      revokeAt,
      minimalRevocations: null,
      note: 'no usage on or after revokeAt can be invalidated by revocation',
    };
  }
  return { workOrder, legal: true, revokeAt, minimalRevocations: { count: best.length, certificates: best } };
}
