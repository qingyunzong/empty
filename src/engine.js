// Calibration state engine.
//
// Semantics:
// - An instrument type defines a default calibration interval (months);
//   a certificate's own valid_months overrides it (individual overrides type).
// - A certificate is valid on day d when issued <= d < expiry, minus any
//   revoked span. Revocation and expiry conflict -> the earlier invalidation
//   point wins (revoke date truncates the validity interval).
// - A measurement taken while the instrument had a valid certificate is never
//   voided. If every certificate interval covering it was later revoked, the
//   measurement is marked "pending_retest" (待复测) instead of invalid.
// - A revoked certificate can be restored only by a certificate from the same
//   institution with a strictly higher level, linked via the restore event.
//   Restoration re-opens validity from the restore date, but the taint of the
//   revoked interval is permanent: its measurements stay pending_retest.
// - Audit: buildState(model, events, asOf) replays only events with
//   date <= asOf, so the usable set can be recomputed for any date.

import { addMonths, fromDays, toDays, formatDate } from './dates.js';
import {
  InputError,
  EXIT_UNTRUSTED_INSTITUTION,
  EXIT_RESTORE_SELF_REFERENCE,
  requireDate,
} from './load.js';

export function buildState(model, rawEvents, asOf = null) {
  const certs = new Map();
  const lifecycle = new Map();
  const restoreEdges = [];

  for (const e of rawEvents) {
    if (!e || typeof e !== 'object') {
      throw new InputError(1, `malformed event ${JSON.stringify(e)}`);
    }
    if (e.event === 'issue') {
      if (!model.trusted.has(e.institution)) {
        throw new InputError(
          EXIT_UNTRUSTED_INSTITUTION,
          `cert ${e.cert}: untrusted institution ${JSON.stringify(e.institution)}`,
        );
      }
      if (certs.has(e.cert)) throw new InputError(1, `duplicate certificate ${e.cert}`);
      const inst = model.instruments.get(e.instrument);
      if (!inst) throw new InputError(1, `cert ${e.cert}: unknown instrument ${e.instrument}`);
      const issued = requireDate(e.issued, `cert ${e.cert} issued`);
      const months = e.valid_months ?? model.types.get(inst.type).intervalMonths;
      if (!Number.isInteger(months) || months <= 0) {
        throw new InputError(1, `cert ${e.cert}: invalid valid_months ${JSON.stringify(months)}`);
      }
      certs.set(e.cert, {
        id: e.cert,
        instrument: e.instrument,
        institution: e.institution,
        level: e.level ?? 1,
        issued,
        months,
        expiry: toDays(addMonths(fromDays(issued), months)),
        tainted: false,
        intervals: [],
      });
      lifecycle.set(e.cert, []);
    }
  }

  for (const e of rawEvents) {
    if (e.event === 'revoke') {
      if (!certs.has(e.cert)) throw new InputError(1, `revoke: unknown certificate ${e.cert}`);
      lifecycle.get(e.cert).push({ kind: 'revoke', day: requireDate(e.date, `revoke ${e.cert}`) });
    } else if (e.event === 'restore') {
      if (!certs.has(e.cert)) throw new InputError(1, `restore: unknown certificate ${e.cert}`);
      if (!certs.has(e.by)) {
        throw new InputError(1, `restore ${e.cert}: unknown restoring certificate ${e.by}`);
      }
      restoreEdges.push([e.cert, e.by]);
      lifecycle.get(e.cert).push({ kind: 'restore', day: requireDate(e.date, `restore ${e.cert}`), by: e.by });
    } else if (e.event !== 'issue') {
      throw new InputError(1, `unknown event type ${JSON.stringify(e.event)}`);
    }
  }

  // Restore-chain self-reference: direct self-loop or cycle (exit 27).
  {
    const edges = new Map();
    for (const [a, b] of restoreEdges) {
      if (a === b) {
        throw new InputError(EXIT_RESTORE_SELF_REFERENCE, `restore chain self-reference: ${a}`);
      }
      if (!edges.has(a)) edges.set(a, []);
      edges.get(a).push(b);
    }
    const color = new Map(); // 1=visiting, 2=done
    const visit = (n) => {
      color.set(n, 1);
      for (const m of edges.get(n) ?? []) {
        if (color.get(m) === 1) {
          throw new InputError(EXIT_RESTORE_SELF_REFERENCE, `restore chain cycle involving ${m}`);
        }
        if (!color.has(m)) visit(m);
      }
      color.set(n, 2);
    };
    for (const n of edges.keys()) if (!color.has(n)) visit(n);
  }

  // Restore legitimacy: same institution, strictly higher level.
  for (const [a, b] of restoreEdges) {
    const ca = certs.get(a);
    const cb = certs.get(b);
    if (ca.institution !== cb.institution) {
      throw new InputError(
        1,
        `restore ${a}: restoring cert ${b} is from ${cb.institution}, must be ${ca.institution}`,
      );
    }
    if (!(cb.level > ca.level)) {
      throw new InputError(1, `restore ${a}: restoring cert ${b} level ${cb.level} must exceed ${ca.level}`);
    }
  }

  // Validity intervals per certificate (revoke closes, restore re-opens,
  // expiry closes implicitly). An interval closed by a revoke is tainted.
  for (const c of certs.values()) {
    const events = lifecycle
      .get(c.id)
      .filter((e) => asOf === null || e.day <= asOf)
      .sort((x, y) => x.day - y.day);
    const raw = [];
    let open = c.issued;
    for (const e of events) {
      if (e.kind === 'revoke') {
        c.tainted = true;
        if (open !== null) {
          raw.push({ start: open, end: e.day, tainted: true });
          open = null;
        }
      } else if (open === null) {
        open = e.day;
      }
    }
    if (open !== null) raw.push({ start: open, end: c.expiry, tainted: false });
    c.intervals = raw
      .map((iv) => ({
        start: Math.max(iv.start, c.issued),
        end: Math.min(iv.end, c.expiry),
        tainted: iv.tainted,
      }))
      .filter((iv) => iv.start < iv.end);
  }

  return { model, certs, rawEvents, asOf };
}

export function coveringIntervals(state, instrumentId, day) {
  const out = [];
  for (const c of state.certs.values()) {
    if (c.instrument !== instrumentId) continue;
    for (const iv of c.intervals) {
      if (iv.start <= day && day < iv.end) out.push({ cert: c, interval: iv });
    }
  }
  return out;
}

export function instrumentUsableAt(state, instrumentId, day) {
  const covering = coveringIntervals(state, instrumentId, day);
  if (covering.length === 0) return { usable: false, reason: 'no_valid_certificate' };
  let best = covering[0].cert;
  for (const { cert } of covering) if (cert.expiry > best.expiry) best = cert;
  return { usable: true, cert: best.id, valid_until: formatDate(fromDays(best.expiry)) };
}

export function measurementStatus(state, record) {
  if (!state.model.instruments.has(record.instrument)) {
    return { status: 'invalid', reason: 'unknown_instrument' };
  }
  const covering = coveringIntervals(state, record.instrument, record.date);
  if (covering.length === 0) return { status: 'invalid', reason: 'no_valid_certificate' };
  const certs = [...new Set(covering.map((x) => x.cert.id))].sort();
  if (covering.some((x) => !x.interval.tainted)) return { status: 'qualified', certs };
  return { status: 'pending_retest', certs };
}

export function workOrderStatus(statuses) {
  if (statuses.some((s) => s.status === 'invalid')) return 'illegal';
  if (statuses.some((s) => s.status === 'pending_retest')) return 'retest_required';
  return 'ok';
}
