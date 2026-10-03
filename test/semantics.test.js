import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInstruments, loadCalibrations, loadUsage } from '../lib/model.js';
import { evaluateUsage, buildStatus, buildImpact, minimalRevocations, isUsable } from '../lib/evaluate.js';
import { EXIT } from '../lib/errors.js';

function makeModel() {
  return loadInstruments({
    trustedInstitutions: ['NIM', 'PTB'],
    types: {
      torque_wrench: { calibrationIntervalDays: 365 },
      gauge_block: { calibrationIntervalDays: 730 },
    },
    instruments: [
      { id: 'TW-001', type: 'torque_wrench' },
      { id: 'GB-001', type: 'gauge_block' },
    ],
  });
}

const lines = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n');

function exitCodeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.exitCode;
  }
  return null;
}

test('A: type interval inherited, individual certificate overrides', () => {
  const model = makeModel();
  const { certificates } = loadCalibrations(lines(
    { kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 1, date: '2025-01-01' },
    { kind: 'certificate', id: 'C2', instrument: 'GB-001', institution: 'PTB', level: 1, date: '2025-01-01', intervalDays: 30 },
  ), model);
  // C1 inherits 365 days from torque_wrench: valid [2025-01-01, 2026-01-01).
  assert.equal(isUsable(certificates, 'TW-001', '2025-12-31'), true);
  assert.equal(isUsable(certificates, 'TW-001', '2026-01-01'), false);
  // C2 overrides the 730-day gauge_block interval with 30 days.
  assert.equal(isUsable(certificates, 'GB-001', '2025-01-30'), true);
  assert.equal(isUsable(certificates, 'GB-001', '2025-01-31'), false);
});

test('A: earlier of revocation and expiry wins', () => {
  const model = makeModel();
  const { certificates } = loadCalibrations(lines(
    { kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 1, date: '2025-01-01' },
    { kind: 'revocation', certificate: 'C1', date: '2025-06-01' },
    { kind: 'certificate', id: 'C2', instrument: 'GB-001', institution: 'PTB', level: 1, date: '2025-01-01', intervalDays: 100 },
    { kind: 'revocation', certificate: 'C2', date: '2025-06-01' },
  ), model);
  // Revocation (2025-06-01) earlier than expiry (2026-01-01): unusable from 2025-06-01.
  assert.equal(isUsable(certificates, 'TW-001', '2025-05-31'), true);
  assert.equal(isUsable(certificates, 'TW-001', '2025-06-01'), false);
  // Expiry (2025-04-11) earlier than revocation (2025-06-01): unusable from 2025-04-11.
  assert.equal(isUsable(certificates, 'GB-001', '2025-04-10'), true);
  assert.equal(isUsable(certificates, 'GB-001', '2025-04-11'), false);
});

test('A: revoked certificate taints passed measurements as pending_retest, not void', () => {
  const model = makeModel();
  const { certificates } = loadCalibrations(lines(
    { kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 1, date: '2025-01-01' },
    { kind: 'revocation', certificate: 'C1', date: '2025-06-01' },
  ), model);
  const usages = loadUsage(lines(
    { workOrder: 'WO-1', instrument: 'TW-001', date: '2025-03-01', result: 'pass' },
    { workOrder: 'WO-2', instrument: 'TW-001', date: '2025-07-01', result: 'pass' },
  ), model);
  const [u1, u2] = usages.map((u) => evaluateUsage(certificates, u));
  assert.equal(u1.status, 'pending_retest');
  assert.equal(u1.certificate, 'C1');
  assert.equal(u1.revokedAt, '2025-06-01');
  assert.equal(u2.status, 'illegal');
});

test('A: untainted overlapping certificate keeps measurement valid', () => {
  const model = makeModel();
  const { certificates } = loadCalibrations(lines(
    { kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 1, date: '2025-01-01' },
    { kind: 'revocation', certificate: 'C1', date: '2025-06-01' },
    { kind: 'certificate', id: 'C2', instrument: 'TW-001', institution: 'PTB', level: 1, date: '2025-01-01', intervalDays: 100 },
  ), model);
  const [usage] = loadUsage(lines(
    { workOrder: 'WO-1', instrument: 'TW-001', date: '2025-03-01', result: 'pass' },
  ), model);
  // C1 is tainted but C2 (expired naturally, never revoked) still covers the date.
  assert.equal(evaluateUsage(certificates, usage).status, 'valid');
});

test('B: reinstatement restores usability but history stays pending_retest', () => {
  const model = makeModel();
  const { certificates } = loadCalibrations(lines(
    { kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 1, date: '2025-01-01' },
    { kind: 'certificate', id: 'C2', instrument: 'TW-001', institution: 'NIM', level: 2, date: '2025-06-28' },
    { kind: 'revocation', certificate: 'C1', date: '2025-06-01' },
    { kind: 'reinstatement', certificate: 'C2', reinstates: 'C1', date: '2025-07-01' },
  ), model);
  // Gap between revocation and any valid coverage.
  assert.equal(isUsable(certificates, 'TW-001', '2025-06-10'), false);
  // Usable again after reinstatement.
  assert.equal(isUsable(certificates, 'TW-001', '2025-07-01'), true);
  const status = buildStatus(model, certificates, '2025-07-15');
  assert.deepEqual(status.usableInstruments, ['TW-001']);
  assert.deepEqual(status.unusableInstruments, ['GB-001']);

  const usages = loadUsage(lines(
    { workOrder: 'WO-1', instrument: 'TW-001', date: '2025-03-01', result: 'pass' },
    { workOrder: 'WO-2', instrument: 'TW-001', date: '2025-07-15', result: 'pass' },
    { workOrder: 'WO-3', instrument: 'TW-001', date: '2025-06-10', result: 'pass' },
  ), model);
  const [u1, u2, u3] = usages.map((u) => evaluateUsage(certificates, u));
  // History measured under the revoked segment remains pending_retest even after reinstatement.
  assert.equal(u1.status, 'pending_retest');
  // New measurements after reinstatement are valid.
  assert.equal(u2.status, 'valid');
  // Measurements inside the uncovered gap are illegal.
  assert.equal(u3.status, 'illegal');

  const impact = buildImpact(usages.map((u) => evaluateUsage(certificates, u)));
  assert.deepEqual(impact.map((i) => [i.workOrder, i.status]), [
    ['WO-1', 'pending_retest'],
    ['WO-3', 'illegal'],
  ]);
});

test('B: reinstatement requires same institution and strictly higher level', () => {
  const base = [
    { kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 2, date: '2025-01-01' },
    { kind: 'revocation', certificate: 'C1', date: '2025-06-01' },
  ];
  // Equal level is not enough.
  assert.equal(exitCodeOf(() => loadCalibrations(lines(...base,
    { kind: 'certificate', id: 'C2', instrument: 'TW-001', institution: 'NIM', level: 2, date: '2025-06-28' },
    { kind: 'reinstatement', certificate: 'C2', reinstates: 'C1', date: '2025-07-01' },
  ), makeModel())), EXIT.VALIDATION);
  // Different institution may not reinstate.
  assert.equal(exitCodeOf(() => loadCalibrations(lines(...base,
    { kind: 'certificate', id: 'C2', instrument: 'TW-001', institution: 'PTB', level: 3, date: '2025-06-28' },
    { kind: 'reinstatement', certificate: 'C2', reinstates: 'C1', date: '2025-07-01' },
  ), makeModel())), EXIT.VALIDATION);
  // Reinstating certificate must itself be valid at the reinstatement date.
  assert.equal(exitCodeOf(() => loadCalibrations(lines(...base,
    { kind: 'certificate', id: 'C2', instrument: 'TW-001', institution: 'NIM', level: 3, date: '2025-06-28' },
    { kind: 'revocation', certificate: 'C2', date: '2025-06-29' },
    { kind: 'reinstatement', certificate: 'C2', reinstates: 'C1', date: '2025-07-01' },
  ), makeModel())), EXIT.VALIDATION);
  // Reinstatement of a certificate that was never revoked.
  assert.equal(exitCodeOf(() => loadCalibrations(lines(
    { kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 1, date: '2025-01-01' },
    { kind: 'certificate', id: 'C2', instrument: 'TW-001', institution: 'NIM', level: 2, date: '2025-06-28' },
    { kind: 'reinstatement', certificate: 'C2', reinstates: 'C1', date: '2025-07-01' },
  ), makeModel())), EXIT.VALIDATION);
});

test('B: reinstatement chain self-reference exits 27', () => {
  const model = makeModel();
  assert.equal(exitCodeOf(() => loadCalibrations(lines(
    { kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 1, date: '2025-01-01' },
    { kind: 'reinstatement', certificate: 'C1', reinstates: 'C1', date: '2025-07-01' },
  ), model)), EXIT.REINSTATEMENT_CYCLE);
});

test('C: certificate spanning the leap day', () => {
  const model = makeModel();
  const { certificates } = loadCalibrations(lines(
    { kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 1, date: '2024-02-28' },
  ), model);
  // 365 inherited days from 2024-02-28 cross 2024-02-29: expiry 2025-02-27 (exclusive).
  assert.equal(isUsable(certificates, 'TW-001', '2024-02-29'), true);
  assert.equal(isUsable(certificates, 'TW-001', '2025-02-26'), true);
  assert.equal(isUsable(certificates, 'TW-001', '2025-02-27'), false);
});

test('audit: usable set recomputed for arbitrary dates', () => {
  const model = makeModel();
  const { certificates } = loadCalibrations(lines(
    { kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 1, date: '2025-01-01' },
    { kind: 'revocation', certificate: 'C1', date: '2025-06-01' },
    { kind: 'certificate', id: 'C2', instrument: 'GB-001', institution: 'PTB', level: 1, date: '2025-03-01' },
  ), model);
  assert.deepEqual(buildStatus(model, certificates, '2025-02-01').usableInstruments, ['TW-001']);
  assert.deepEqual(buildStatus(model, certificates, '2025-05-31').usableInstruments, ['GB-001', 'TW-001']);
  assert.deepEqual(buildStatus(model, certificates, '2025-06-01').usableInstruments, ['GB-001']);
});

test('counterexample: minimal revocation set turning a work order illegal', () => {
  const model = makeModel();
  const { certificates } = loadCalibrations(lines(
    { kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 1, date: '2025-01-01' },
    { kind: 'certificate', id: 'C2', instrument: 'TW-001', institution: 'PTB', level: 1, date: '2025-01-01' },
    { kind: 'certificate', id: 'C3', instrument: 'GB-001', institution: 'NIM', level: 1, date: '2025-01-01' },
  ), model);
  const usages = loadUsage(lines(
    { workOrder: 'WO-1', instrument: 'TW-001', date: '2025-03-01', result: 'pass' },
    { workOrder: 'WO-1', instrument: 'GB-001', date: '2025-03-02', result: 'pass' },
    { workOrder: 'WO-2', instrument: 'TW-001', date: '2025-03-01', result: 'pass' },
  ), model);
  // Two certificates cover 2025-03-01 on TW-001, one covers 2025-03-02 on GB-001:
  // revoking C3 alone breaks the work order.
  const result = minimalRevocations(certificates, usages, 'WO-1', '2025-02-01');
  assert.equal(result.legal, true);
  assert.deepEqual(result.minimalRevocations, { count: 1, certificates: ['C3'] });
  // WO-2 needs both TW-001 certificates revoked.
  const result2 = minimalRevocations(certificates, usages, 'WO-2', '2025-02-01');
  assert.deepEqual(result2.minimalRevocations, { count: 2, certificates: ['C1', 'C2'] });
  // Revoking after every usage date cannot invalidate anything.
  const result3 = minimalRevocations(certificates, usages, 'WO-1', '2025-03-03');
  assert.equal(result3.minimalRevocations, null);
  // Unknown work order is a validation error.
  assert.equal(exitCodeOf(() => minimalRevocations(certificates, usages, 'WO-9', '2025-06-01')), EXIT.VALIDATION);
});
