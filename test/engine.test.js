import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstruments, InputError } from '../src/load.js';
import { buildState, instrumentUsableAt, measurementStatus, workOrderStatus } from '../src/engine.js';
import { toDays, parseDate } from '../src/dates.js';

const D = (s) => toDays(parseDate(s));

function makeModel() {
  return parseInstruments(JSON.stringify({
    trusted_institutions: ['NIM', 'CMA'],
    instrument_types: {
      torque_wrench: { calibration_interval_months: 12 },
      gauge_block: { calibration_interval_months: 6 },
    },
    instruments: [
      { id: 'TW-1', type: 'torque_wrench' },
      { id: 'TW-2', type: 'torque_wrench' },
      { id: 'GB-1', type: 'gauge_block' },
    ],
  }));
}

const rec = (instrument, date, wo = 'WO-1') => ({
  work_order: wo, measurement: `${wo}-${instrument}-${date}`, instrument, date: D(date), dateText: date,
});

test('A: type interval inherited; individual cert overrides; earlier of revoke/expiry wins', () => {
  const model = makeModel();
  const events = [
    { event: 'issue', cert: 'C1', instrument: 'TW-1', institution: 'NIM', level: 1, issued: '2024-01-10' },
    { event: 'issue', cert: 'C2', instrument: 'TW-2', institution: 'NIM', level: 1, issued: '2024-01-10', valid_months: 3 },
    { event: 'revoke', cert: 'C1', date: '2024-06-01' },
  ];
  const state = buildState(model, events, D('2024-08-01'));

  // Inherited 12-month interval would expire 2025-01-10, but the 2024-06-01
  // revocation is the earlier invalidation point.
  assert.equal(instrumentUsableAt(state, 'TW-1', D('2024-05-31')).usable, true);
  assert.equal(instrumentUsableAt(state, 'TW-1', D('2024-06-01')).usable, false);

  // Individual override: 3 months -> expiry 2024-04-10 (type says 12).
  assert.equal(instrumentUsableAt(state, 'TW-2', D('2024-04-09')).usable, true);
  assert.equal(instrumentUsableAt(state, 'TW-2', D('2024-04-10')).usable, false);

  // Measurement while valid -> pending_retest (not voided); after revoke -> invalid.
  assert.equal(measurementStatus(state, rec('TW-1', '2024-03-01')).status, 'pending_retest');
  assert.equal(measurementStatus(state, rec('TW-1', '2024-07-01')).status, 'invalid');
});

test('A: without revocation, measurements stay qualified and expiry invalidates', () => {
  const model = makeModel();
  const events = [
    { event: 'issue', cert: 'C1', instrument: 'TW-1', institution: 'NIM', level: 1, issued: '2024-01-10' },
  ];
  const state = buildState(model, events, D('2025-02-01'));
  assert.equal(instrumentUsableAt(state, 'TW-1', D('2025-01-09')).usable, true);
  assert.equal(instrumentUsableAt(state, 'TW-1', D('2025-01-10')).usable, false);
  assert.equal(measurementStatus(state, rec('TW-1', '2024-06-01')).status, 'qualified');
  assert.equal(measurementStatus(state, rec('TW-1', '2025-02-01')).status, 'invalid');
  assert.equal(workOrderStatus([measurementStatus(state, rec('TW-1', '2024-06-01'))]), 'ok');
});

test('B: restore re-opens usability but history stays pending_retest', () => {
  const model = makeModel();
  const events = [
    { event: 'issue', cert: 'C1', instrument: 'TW-1', institution: 'NIM', level: 1, issued: '2024-01-01' },
    { event: 'issue', cert: 'C2', instrument: 'TW-1', institution: 'NIM', level: 2, issued: '2024-06-20' },
    { event: 'revoke', cert: 'C1', date: '2024-06-01' },
    { event: 'restore', cert: 'C1', by: 'C2', date: '2024-07-01' },
  ];
  const state = buildState(model, events, D('2024-08-01'));

  // Usable again after the restore date.
  assert.equal(instrumentUsableAt(state, 'TW-1', D('2024-06-15')).usable, false);
  assert.equal(instrumentUsableAt(state, 'TW-1', D('2024-08-01')).usable, true);

  // History under the revoked interval stays pending_retest even after restore.
  assert.equal(measurementStatus(state, rec('TW-1', '2024-03-01')).status, 'pending_retest');
  // Gap between revoke and restore was never covered.
  assert.equal(measurementStatus(state, rec('TW-1', '2024-06-15')).status, 'invalid');
  // New measurements in the restored interval are qualified again.
  assert.equal(measurementStatus(state, rec('TW-1', '2024-07-15')).status, 'qualified');
});

test('B: restore requires same institution and strictly higher level', () => {
  const model = makeModel();
  const base = [
    { event: 'issue', cert: 'C1', instrument: 'TW-1', institution: 'NIM', level: 2, issued: '2024-01-01' },
    { event: 'issue', cert: 'C2', instrument: 'TW-1', institution: 'CMA', level: 3, issued: '2024-06-20' },
    { event: 'issue', cert: 'C3', instrument: 'TW-1', institution: 'NIM', level: 2, issued: '2024-06-20' },
    { event: 'revoke', cert: 'C1', date: '2024-06-01' },
  ];
  assert.throws(
    () => buildState(model, [...base, { event: 'restore', cert: 'C1', by: 'C2', date: '2024-07-01' }]),
    (e) => e instanceof InputError && e.exitCode === 1,
  );
  assert.throws(
    () => buildState(model, [...base, { event: 'restore', cert: 'C1', by: 'C3', date: '2024-07-01' }]),
    (e) => e instanceof InputError && e.exitCode === 1,
  );
});

test('C: leap-year boundary for issue, expiry and measurement dates', () => {
  const model = makeModel();
  const events = [
    // 2024 is a leap year: 2024-02-29 is a real date; 6-month type interval.
    { event: 'issue', cert: 'C1', instrument: 'GB-1', institution: 'NIM', level: 1, issued: '2024-02-29' },
    // 12-month override from 2024-02-29 clamps to 2025-02-28 (2025 not leap).
    { event: 'issue', cert: 'C2', instrument: 'TW-2', institution: 'NIM', level: 1, issued: '2024-02-29', valid_months: 12 },
  ];
  const state = buildState(model, events, D('2025-03-15'));

  assert.equal(instrumentUsableAt(state, 'GB-1', D('2024-08-28')).usable, true);
  assert.equal(instrumentUsableAt(state, 'GB-1', D('2024-08-29')).usable, false);

  assert.equal(instrumentUsableAt(state, 'TW-2', D('2025-02-27')).usable, true);
  assert.equal(instrumentUsableAt(state, 'TW-2', D('2025-02-28')).usable, false);

  // A measurement on the leap day itself is covered and qualified.
  assert.equal(measurementStatus(state, rec('GB-1', '2024-02-29')).status, 'qualified');
  assert.equal(measurementStatus(state, rec('TW-2', '2025-02-28')).status, 'invalid');
});

test('audit: usable set is recomputed from any as-of date', () => {
  const model = makeModel();
  const events = [
    { event: 'issue', cert: 'C1', instrument: 'TW-1', institution: 'NIM', level: 1, issued: '2024-01-01' },
    { event: 'revoke', cert: 'C1', date: '2024-06-01' },
  ];
  const before = buildState(model, events, D('2024-05-01'));
  const after = buildState(model, events, D('2024-08-01'));
  // As of May the revocation is not yet known: instrument usable, measurement qualified.
  assert.equal(instrumentUsableAt(before, 'TW-1', D('2024-05-01')).usable, true);
  assert.equal(measurementStatus(before, rec('TW-1', '2024-03-01')).status, 'qualified');
  // As of August the same history is recomputed: unusable now, measurement tainted.
  assert.equal(instrumentUsableAt(after, 'TW-1', D('2024-08-01')).usable, false);
  assert.equal(measurementStatus(after, rec('TW-1', '2024-03-01')).status, 'pending_retest');
});
