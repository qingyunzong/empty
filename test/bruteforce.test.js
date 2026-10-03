import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInstruments, loadCalibrations, loadUsage } from '../lib/model.js';
import { evaluateUsage, isUsable, minimalRevocations } from '../lib/evaluate.js';
import { addDays, compareDates } from '../lib/dates.js';

// --- Independent brute-force reference implementation -----------------------
// Replays each certificate's events day by day instead of using precomputed
// segments, so the library's segment logic is cross-checked against a
// structurally different computation.

function certEvents(events, certId) {
  return events
    .filter((e) => e.kind !== 'certificate'
      && (e.certificateId === certId || e.reinstatesId === certId))
    .sort((a, b) => compareDates(a.date, b.date)
      || (a.kind === 'revocation' ? 0 : 1) - (b.kind === 'revocation' ? 0 : 1));
}

function bruteActiveAt(cert, events, day) {
  if (compareDates(day, cert.date) < 0 || compareDates(day, cert.expiry) >= 0) return false;
  let active = true;
  for (const ev of certEvents(events, cert.id)) {
    if (compareDates(ev.date, day) > 0) break;
    active = ev.kind !== 'revocation';
  }
  return active;
}

function bruteUsable(certs, events, instrumentId, day) {
  return certs.some((c) => c.instrument === instrumentId && bruteActiveAt(c, events, day));
}

function bruteUsageStatus(certs, events, usage) {
  let any = false;
  let anyUntainted = false;
  for (const cert of certs) {
    if (cert.instrument !== usage.instrument) continue;
    if (!bruteActiveAt(cert, events, usage.date)) continue;
    any = true;
    const later = certEvents(events, cert.id).filter((e) => compareDates(e.date, usage.date) > 0);
    const tainted = later.length > 0 && later[0].kind === 'revocation'
      && compareDates(later[0].date, cert.expiry) < 0;
    if (!tainted) anyUntainted = true;
  }
  const legality = anyUntainted ? 'valid' : any ? 'pending_retest' : 'illegal';
  return usage.result === 'pass' ? legality : 'failed';
}

function bruteCovered(certs, events, instrumentId, day, revokedSet, revokeAt) {
  return certs.some((c) => c.instrument === instrumentId
    && !(revokedSet.has(c.id) && compareDates(day, revokeAt) >= 0)
    && bruteActiveAt(c, events, day));
}

function bruteWorkOrderIllegal(certs, events, woUsages, revokedSet, revokeAt) {
  return woUsages.some((u) => !bruteCovered(certs, events, u.instrument, u.date, revokedSet, revokeAt));
}

function* subsets(ids, size, start = 0, prefix = []) {
  if (prefix.length === size) {
    yield prefix;
    return;
  }
  for (let i = start; i < ids.length; i += 1) {
    yield* subsets(ids, size, i + 1, [...prefix, ids[i]]);
  }
}

function bruteMinimalRevocations(certs, events, woUsages, revokeAt) {
  if (bruteWorkOrderIllegal(certs, events, woUsages, new Set(), revokeAt)) return 0;
  const candidates = [...new Set(woUsages
    .filter((u) => compareDates(u.date, revokeAt) >= 0)
    .flatMap((u) => certs.filter((c) => c.instrument === u.instrument && bruteActiveAt(c, events, u.date)))
    .map((c) => c.id))];
  for (let size = 1; size <= candidates.length; size += 1) {
    for (const combo of subsets(candidates, size)) {
      if (bruteWorkOrderIllegal(certs, events, woUsages, new Set(combo), revokeAt)) return size;
    }
  }
  return null;
}

// --- Seeded random scenario generation --------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genScenario(seed, windowStart, windowDays) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const institutions = ['NIM', 'PTB'];
  const model = loadInstruments({
    trustedInstitutions: institutions,
    types: {
      torque_wrench: { calibrationIntervalDays: 10 },
      gauge_block: { calibrationIntervalDays: 15 },
    },
    instruments: Array.from({ length: 6 }, (_, i) => ({
      id: `I${i}`,
      type: i % 2 === 0 ? 'torque_wrench' : 'gauge_block',
    })),
  });
  const rawEvents = [];
  let certSeq = 0;
  for (let i = 0; i < 6; i += 1) {
    const instrument = `I${i}`;
    const active = [];
    const revoked = [];
    for (let d = 0; d < windowDays; d += 1) {
      const date = addDays(windowStart, d);
      const roll = rnd();
      if (roll < 0.10 || (d === 0 && active.length === 0)) {
        const id = `K${certSeq}`;
        certSeq += 1;
        const cert = {
          kind: 'certificate', id, instrument,
          institution: pick(institutions),
          level: 1 + Math.floor(rnd() * 3),
          date,
        };
        if (rnd() < 0.5) cert.intervalDays = 5 + Math.floor(rnd() * 16);
        const interval = cert.intervalDays ?? (i % 2 === 0 ? 10 : 15);
        cert._expiry = addDays(date, interval);
        rawEvents.push(cert);
        active.push(cert);
      } else if (roll < 0.16 && active.length > 0) {
        const cert = active.splice(Math.floor(rnd() * active.length), 1)[0];
        rawEvents.push({ kind: 'revocation', certificate: cert.id, date });
        revoked.push(cert);
      } else if (roll < 0.22 && revoked.length > 0) {
        const target = revoked.splice(Math.floor(rnd() * revoked.length), 1)[0];
        if (compareDates(date, target._expiry) >= 0) continue;
        const id = `K${certSeq}`;
        certSeq += 1;
        const by = {
          kind: 'certificate', id, instrument,
          institution: target.institution,
          level: target.level + 1,
          date,
          intervalDays: 20,
          _expiry: addDays(date, 20),
        };
        rawEvents.push(by, { kind: 'reinstatement', certificate: id, reinstates: target.id, date });
        active.push(by, target);
      }
    }
  }
  const usages = Array.from({ length: 24 }, (_, i) => ({
    workOrder: `WO-${Math.floor(i / 4)}`,
    instrument: `I${Math.floor(rnd() * 6)}`,
    date: addDays(windowStart, Math.floor(rnd() * windowDays)),
    result: rnd() < 0.85 ? 'pass' : 'fail',
  }));
  return { model, rawEvents, usages, windowStart, windowDays };
}

const lines = (objs) => objs.map((o) => JSON.stringify(o)).join('\n');

for (const [label, start] of [['non-leap window', '2025-01-05'], ['leap window', '2024-02-10']]) {
  test(`D: library matches brute force over 30 days x 6 instruments (${label})`, () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const { model, rawEvents, usages, windowStart, windowDays } = genScenario(seed, start, 30);
      const { certificates, events } = loadCalibrations(lines(rawEvents), model);
      const certs = [...certificates.values()];
      const parsedUsages = loadUsage(lines(usages), model);

      for (let d = 0; d < windowDays; d += 1) {
        const day = addDays(windowStart, d);
        for (let i = 0; i < 6; i += 1) {
          assert.equal(
            isUsable(certificates, `I${i}`, day),
            bruteUsable(certs, events, `I${i}`, day),
            `seed ${seed} day ${day} instrument I${i}`,
          );
        }
      }
      for (const usage of parsedUsages) {
        assert.equal(
          evaluateUsage(certificates, usage).status,
          bruteUsageStatus(certs, events, usage),
          `seed ${seed} usage ${JSON.stringify(usage)}`,
        );
      }
    }
  });
}

test('D: minimal revocation counterexample matches exhaustive subset search', () => {
  for (let seed = 101; seed <= 140; seed += 1) {
    const { model, rawEvents, usages, windowStart } = genScenario(seed, '2025-01-05', 30);
    const { certificates, events } = loadCalibrations(lines(rawEvents), model);
    const certs = [...certificates.values()];
    const parsedUsages = loadUsage(lines(usages), model);
    const revokeAt = addDays(windowStart, 20);

    for (const wo of ['WO-0', 'WO-2', 'WO-5']) {
      const woUsages = parsedUsages.filter((u) => u.workOrder === wo);
      if (woUsages.length === 0) continue;
      const expected = bruteMinimalRevocations(certs, events, woUsages, revokeAt);
      const result = minimalRevocations(certificates, parsedUsages, wo, revokeAt);
      const actual = result.minimalRevocations === null ? null : result.minimalRevocations.count;
      assert.equal(actual, expected, `seed ${seed} work order ${wo}`);
      if (result.minimalRevocations !== null && result.minimalRevocations.count > 0) {
        // The returned certificate set must actually break the work order.
        assert.ok(bruteWorkOrderIllegal(
          certs, events, woUsages, new Set(result.minimalRevocations.certificates), revokeAt,
        ), `seed ${seed} work order ${wo}: returned set ineffective`);
      }
    }
  }
});
