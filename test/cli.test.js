import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../lib/run.js';

const INSTRUMENTS = {
  trustedInstitutions: ['NIM', 'PTB'],
  types: {
    torque_wrench: { calibrationIntervalDays: 365 },
    gauge_block: { calibrationIntervalDays: 730 },
  },
  instruments: [
    { id: 'TW-001', type: 'torque_wrench' },
    { id: 'GB-001', type: 'gauge_block' },
  ],
};

const CALIBRATIONS = [
  { kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 1, date: '2025-01-01' },
  { kind: 'revocation', certificate: 'C1', date: '2025-06-01' },
  { kind: 'certificate', id: 'C2', instrument: 'GB-001', institution: 'PTB', level: 1, date: '2025-03-01' },
];

const USAGE = [
  { workOrder: 'WO-1', instrument: 'TW-001', date: '2025-03-01', result: 'pass' },
  { workOrder: 'WO-2', instrument: 'TW-001', date: '2025-07-01', result: 'pass' },
  { workOrder: 'WO-3', instrument: 'GB-001', date: '2025-07-01', result: 'pass' },
];

function makeDir(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrology-'));
  fs.writeFileSync(path.join(dir, 'instruments.json'), JSON.stringify(overrides.instruments ?? INSTRUMENTS));
  fs.writeFileSync(path.join(dir, 'calibrations.jsonl'),
    (overrides.calibrations ?? CALIBRATIONS).map((o) => JSON.stringify(o)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'usage.jsonl'),
    (overrides.usage ?? USAGE).map((o) => JSON.stringify(o)).join('\n') + '\n');
  return dir;
}

function run(dir, extra = []) {
  const captured = { stdout: '', stderr: '' };
  const status = runCli([
    '--instruments', path.join(dir, 'instruments.json'),
    '--calibrations', path.join(dir, 'calibrations.jsonl'),
    '--usage', path.join(dir, 'usage.jsonl'),
    '--as-of', '2025-07-15',
    '--status-out', path.join(dir, 'status.json'),
    '--impact-out', path.join(dir, 'impact.jsonl'),
    ...extra,
  ], { stdout: (s) => { captured.stdout += s; }, stderr: (s) => { captured.stderr += s; } });
  return { status, ...captured };
}

test('CLI happy path writes status.json and impact.jsonl', () => {
  const dir = makeDir();
  const res = run(dir);
  assert.equal(res.status, 0, res.stderr);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.asOf, '2025-07-15');
  assert.deepEqual(status.usableInstruments, ['GB-001']);
  assert.deepEqual(status.unusableInstruments, ['TW-001']);
  const impact = fs.readFileSync(path.join(dir, 'impact.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(impact, [
    {
      workOrder: 'WO-1', instrument: 'TW-001', date: '2025-03-01', result: 'pass',
      status: 'pending_retest', certificate: 'C1', reason: 'certificate_revoked', revokedAt: '2025-06-01',
    },
    {
      workOrder: 'WO-2', instrument: 'TW-001', date: '2025-07-01', result: 'pass',
      status: 'illegal', certificate: null, reason: 'no_valid_certificate',
    },
  ]);
});

test('CLI counterexample prints minimal revocation set', () => {
  const dir = makeDir();
  const res = run(dir, ['--counterexample', 'WO-2', '--revoke-at', '2025-06-15']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.workOrder, 'WO-2');
  assert.equal(out.legal, false);
  assert.deepEqual(out.minimalRevocations, { count: 0, certificates: [] });

  const res2 = run(dir, ['--counterexample', 'WO-3', '--revoke-at', '2025-06-15']);
  const out2 = JSON.parse(res2.stdout);
  assert.equal(out2.legal, true);
  assert.deepEqual(out2.minimalRevocations, { count: 1, certificates: ['C2'] });
});

test('CLI exits 25 on invalid dates', () => {
  const dir = makeDir({
    calibrations: [{ kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 1, date: '2025-02-30' }],
  });
  assert.equal(run(dir).status, 25);

  const dir2 = makeDir();
  const res = run(dir2, ['--as-of', '2024-02-30']);
  assert.equal(res.status, 25);

  const dir3 = makeDir({ usage: [{ workOrder: 'WO-1', instrument: 'TW-001', date: 'not-a-date' }] });
  assert.equal(run(dir3).status, 25);
});

test('CLI exits 26 on untrusted institution', () => {
  const dir = makeDir({
    calibrations: [{ kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'ACME', level: 1, date: '2025-01-01' }],
  });
  const res = run(dir);
  assert.equal(res.status, 26);
  assert.match(res.stderr, /untrusted institution/);
});

test('CLI exits 27 on reinstatement chain self-reference', () => {
  const dir = makeDir({
    calibrations: [
      { kind: 'certificate', id: 'C1', instrument: 'TW-001', institution: 'NIM', level: 1, date: '2025-01-01' },
      { kind: 'reinstatement', certificate: 'C1', reinstates: 'C1', date: '2025-07-01' },
    ],
  });
  const res = run(dir);
  assert.equal(res.status, 27);
  assert.match(res.stderr, /self-reference/);
});
