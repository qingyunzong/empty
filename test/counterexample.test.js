import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstruments, parseUsage } from '../src/load.js';
import { buildState } from '../src/engine.js';
import {
  findMinimalRevocations,
  bruteForceMinimalRevocations,
  applyRevocations,
  workOrderStatusFor,
} from '../src/counterexample.js';
import { toDays, fromDays, parseDate, formatDate } from '../src/dates.js';

const D = (s) => toDays(parseDate(s));
const fmt = (d) => formatDate(fromDays(d));

function makeModel(instruments) {
  return parseInstruments(JSON.stringify({
    trusted_institutions: ['NIM'],
    instrument_types: {
      torque_wrench: { calibration_interval_months: 12 },
      gauge_block: { calibration_interval_months: 6 },
    },
    instruments,
  }));
}

test('counterexample: minimal revocation set is exact', () => {
  const model = makeModel([
    { id: 'TW-1', type: 'torque_wrench' },
    { id: 'TW-2', type: 'torque_wrench' },
  ]);
  const events = [
    { event: 'issue', cert: 'C1', instrument: 'TW-1', institution: 'NIM', level: 1, issued: '2024-01-01' },
    { event: 'issue', cert: 'C2', instrument: 'TW-2', institution: 'NIM', level: 1, issued: '2024-01-01' },
    { event: 'issue', cert: 'C3', instrument: 'TW-2', institution: 'NIM', level: 1, issued: '2024-01-05' },
  ];
  const usage = parseUsage([
    JSON.stringify({ work_order: 'WO-1', measurement: 'M1', instrument: 'TW-1', date: '2024-03-01' }),
    JSON.stringify({ work_order: 'WO-1', measurement: 'M2', instrument: 'TW-2', date: '2024-03-01' }),
  ].join('\n'));
  const asOf = D('2024-08-01');
  const state = buildState(model, events, asOf);

  const found = findMinimalRevocations(state, usage);
  assert.deepEqual(found, { size: 1, certs: ['C1'] });

  const brute = bruteForceMinimalRevocations(state, usage, asOf);
  assert.equal(brute.size, 1);

  // Applying the found set flips the work order out of "ok".
  const broken = applyRevocations(state, found.certs, asOf);
  assert.notEqual(workOrderStatusFor(broken, usage), 'ok');
});

test('counterexample: returns null when work order is already not ok', () => {
  const model = makeModel([{ id: 'TW-1', type: 'torque_wrench' }]);
  const events = [
    { event: 'issue', cert: 'C1', instrument: 'TW-1', institution: 'NIM', level: 1, issued: '2024-01-01' },
    { event: 'revoke', cert: 'C1', date: '2024-06-01' },
  ];
  const usage = parseUsage(JSON.stringify({
    work_order: 'WO-1', measurement: 'M1', instrument: 'TW-1', date: '2024-03-01',
  }));
  const state = buildState(model, events, D('2024-08-01'));
  assert.equal(findMinimalRevocations(state, usage), null);
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random scenario: 6 instruments, 30-day measurement window, 1-2 certs per
// instrument, occasional revocations, 1-3 work orders of 1-4 measurements.
function genScenario(rng) {
  const base = D('2024-01-01');
  const instruments = [];
  for (let i = 0; i < 6; i++) {
    instruments.push({ id: `I${i}`, type: rng() < 0.5 ? 'torque_wrench' : 'gauge_block' });
  }
  const model = makeModel(instruments);
  const events = [];
  let certN = 0;
  for (const inst of instruments) {
    const nCerts = 1 + Math.floor(rng() * 2);
    for (let k = 0; k < nCerts; k++) {
      const id = `C${certN++}`;
      const issued = base - 20 + Math.floor(rng() * 25);
      const months = rng() < 0.5 ? 1 : 2;
      events.push({
        event: 'issue', cert: id, instrument: inst.id, institution: 'NIM',
        level: 1, issued: fmt(issued), valid_months: months,
      });
      if (rng() < 0.25) {
        events.push({ event: 'revoke', cert: id, date: fmt(base + Math.floor(rng() * 35)) });
      }
    }
  }
  const lines = [];
  const nWO = 1 + Math.floor(rng() * 3);
  for (let w = 0; w < nWO; w++) {
    const nM = 1 + Math.floor(rng() * 4);
    for (let m = 0; m < nM; m++) {
      lines.push(JSON.stringify({
        work_order: `WO-${w}`,
        measurement: `M${w}-${m}`,
        instrument: instruments[Math.floor(rng() * 6)].id,
        date: fmt(base + Math.floor(rng() * 30)),
      }));
    }
  }
  return { model, events, usage: parseUsage(lines.join('\n')), asOf: base + 30 };
}

test('D: enumeration cross-check over <=30 days / 6 instruments', () => {
  const rng = mulberry32(20241001);
  let checked = 0;
  for (let trial = 0; trial < 300; trial++) {
    const { model, events, usage, asOf } = genScenario(rng);
    const state = buildState(model, events, asOf);
    const byWO = new Map();
    for (const u of usage) {
      if (!byWO.has(u.work_order)) byWO.set(u.work_order, []);
      byWO.get(u.work_order).push(u);
    }
    for (const records of byWO.values()) {
      if (workOrderStatusFor(state, records) !== 'ok') continue;
      const expected = bruteForceMinimalRevocations(state, records, asOf);
      const actual = findMinimalRevocations(state, records);
      assert.ok(actual !== null, 'finder must succeed on an ok work order');
      assert.ok(expected !== null, 'brute force must find a revocation set');
      assert.equal(actual.size, expected.size,
        `size mismatch: finder=${actual.certs} brute=${expected.certs}`);
      const broken = applyRevocations(state, actual.certs, asOf);
      assert.notEqual(workOrderStatusFor(broken, records), 'ok',
        `finder set ${actual.certs} does not break the work order`);
      checked++;
    }
  }
  assert.ok(checked > 100, `too few ok work orders exercised: ${checked}`);
  console.log(`cross-checked ${checked} ok work orders against brute force`);
});
