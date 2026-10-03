import test from 'node:test';
import assert from 'node:assert/strict';
import { Certifier } from '../src/certify.js';

// Acceptance 3: enumerate every subset of a small event base and compare the
// engine's append-only emission stream against an independent reference
// implementation written directly from the rules.

const OPTS = { windowMs: 500, watermarkLagMs: 1e15, angleMin: 0, angleMax: 720 };

const BASE = [
  { kind: 'calib', id: 'c1', eventTs: 100, tool: 'T1', ok: true, validFrom: 0, validTo: 20000, op: null },
  { kind: 'torque', id: 't1', eventTs: 10000, bolt: 'B1', tool: 'T1', peak: 10, angle: 90, op: null },
  { kind: 'scan', id: 's1', eventTs: 10200, bolt: 'B1', lot: 'L1', op: null },
  { kind: 'torque', id: 't2', eventTs: 11000, bolt: 'B1', tool: 'T1', peak: 12, angle: 95, op: null },
  { kind: 'retract', id: 'retract#calib#c1', eventTs: 12000, targetKind: 'calib', targetId: 'c1' },
  { kind: 'calib', id: 'c2', eventTs: 13000, tool: 'T1', ok: true, validFrom: 5000, validTo: 15000, op: null },
  { kind: 'retract', id: 'retract#torque#t2', eventTs: 14000, targetKind: 'torque', targetId: 't2' },
  { kind: 'torque', id: 't3', eventTs: 15000, bolt: 'B1', tool: 'T1', peak: 9, angle: 9999, op: null },
];

function later(a, b) {
  if (a.eventTs !== b.eventTs) return a.eventTs > b.eventTs ? a : b;
  return a.id >= b.id ? a : b;
}

function referenceRun(events) {
  const { windowMs, angleMin, angleMax } = OPTS;
  const byId = new Map();
  const retracted = new Set();
  const lastEmitted = new Map();
  const versions = new Map();
  const emissions = [];

  const evaluate = (bolt) => {
    const torques = [...byId.values()].filter(
      (e) => e.kind === 'torque' && e.bolt === bolt && !retracted.has(e.id),
    );
    const qualified = torques.filter((t) => t.angle >= angleMin && t.angle <= angleMax);
    if (qualified.length === 0) return null;
    const winner = qualified.reduce(later);
    const lo = winner.eventTs - windowMs;
    const hi = winner.eventTs + windowMs;
    const overlaps = (c) => c.validFrom <= hi && c.validTo >= lo;
    const calibs = [...byId.values()].filter((e) => e.kind === 'calib' && e.tool === winner.tool);
    const valid = calibs.filter((c) => !retracted.has(c.id) && c.ok === true && overlaps(c));
    const cal = valid.length > 0 ? valid.reduce(later) : null;
    const retractedApplicable = calibs.some((c) => retracted.has(c.id) && c.ok === true && overlaps(c));
    const scans = [...byId.values()].filter(
      (e) => e.kind === 'scan' && e.bolt === bolt && !retracted.has(e.id)
        && Math.abs(e.eventTs - winner.eventTs) <= windowMs,
    );
    const sc = scans.length > 0 ? scans.reduce(later) : null;
    const reasons = [];
    if (!cal) reasons.push(retractedApplicable ? 'CALIB_RETRACTED' : 'NO_CALIB');
    if (!sc) reasons.push('MISSING_LOT');
    let status = 'OK';
    if (reasons.includes('CALIB_RETRACTED')) status = 'VOID';
    else if (reasons.length > 0) status = 'HOLD';
    return {
      bolt, status, reasons,
      torqueId: winner.id, calibId: cal ? cal.id : null, lot: sc ? sc.lot : null,
    };
  };

  const voidFor = (bolt) => {
    const rq = [...byId.values()].some(
      (e) => e.kind === 'torque' && e.bolt === bolt && retracted.has(e.id)
        && e.angle >= angleMin && e.angle <= angleMax,
    );
    return {
      bolt, status: 'VOID', reasons: [rq ? 'TORQUE_RETRACTED' : 'NO_VALID_TORQUE'],
      torqueId: null, calibId: null, lot: null,
    };
  };

  for (const ev of events) {
    if (ev.kind === 'retract') retracted.add(ev.targetId);
    else byId.set(ev.id, ev);
    const bolts = new Set([...byId.values()].filter((e) => e.bolt).map((e) => e.bolt));
    for (const bolt of bolts) {
      const cert = evaluate(bolt) ?? voidFor(bolt);
      const prev = lastEmitted.get(bolt);
      if (!prev && cert.status === 'VOID' && cert.torqueId === null) continue;
      if (prev && JSON.stringify(prev) === JSON.stringify(cert)) continue;
      const version = (versions.get(bolt) ?? 0) + 1;
      versions.set(bolt, version);
      lastEmitted.set(bolt, cert);
      emissions.push({
        stream: cert.status === 'VOID' ? 'void' : 'certs',
        bolt, version, status: cert.status, reasons: cert.reasons,
        torqueId: cert.torqueId, calibId: cert.calibId, lot: cert.lot,
      });
    }
  }
  return emissions;
}

function engineRun(events) {
  const c = new Certifier(OPTS);
  for (const ev of events) c.ingest(ev);
  return c.emissions.map(({ stream, record }) => ({
    stream,
    bolt: record.bolt,
    version: record.version,
    status: record.status,
    reasons: record.reasons,
    torqueId: record.torqueId,
    calibId: record.calibId,
    lot: record.lot,
  }));
}

test('acceptance 3: all 2^8 event subsets match the reference certifier', () => {
  const n = BASE.length;
  let checked = 0;
  for (let mask = 0; mask < 2 ** n; mask += 1) {
    const subset = BASE.filter((_, i) => (mask >> i) & 1);
    const expected = referenceRun(subset);
    const actual = engineRun(subset);
    assert.deepEqual(actual, expected, `mismatch for subset mask=${mask.toString(2).padStart(n, '0')}`);
    checked += 1;
  }
  assert.equal(checked, 256);
});
