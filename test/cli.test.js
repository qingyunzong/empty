// CLI tests drive runCli in-process (the sandbox forbids child processes);
// bin/clearing.js is a thin wrapper around the same function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { ROOT } from './helpers.js';

const TZDB = join(ROOT, 'examples/tzdb.json');
const CALS = join(ROOT, 'examples/calendars.json');

function tmp() {
  return mkdtempSync(join(tmpdir(), 'clearing-'));
}

function run(args) {
  const out = { stdout: '', stderr: '' };
  const status = runCli(args, {
    stdout: (t) => { out.stdout += t; },
    stderr: (t) => { out.stderr += t; },
  });
  return { status, ...out };
}

function writeFlows(dir, flows) {
  const p = join(dir, 'flows.json');
  writeFileSync(p, JSON.stringify(flows));
  return p;
}

const baseFlow = {
  id: 't1', seq: 1, account: 'A', calendar: 'US-NY', type: 'post',
  amount: 100, currency: 'USD', localTime: '2024-06-10T10:00',
};

test('CLI settle writes report + state; verify confirms the certificate', () => {
  const dir = tmp();
  const flows = join(ROOT, 'examples/flows.json');
  const report = join(dir, 'report.json');
  const state = join(dir, 'state.json');
  const r1 = run(['settle', '--tzdb', TZDB, '--calendars', CALS, '--flows', flows, '--out', report, '--state-out', state]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stderr, /settle ok/);
  const doc = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(doc.certificate.scheme, 'clearing-daycut/v1');
  assert.match(doc.certificate.ruleVersion, /tzdb=2024a/);
  assert.ok(doc.certificate.intervals.length > 0);
  const shaRow = doc.nets.find((n) => n.calendar === 'CN-SHA');
  assert.equal(shaRow.date, '2024-06-11');

  const r2 = run(['verify', '--tzdb', TZDB, '--calendars', CALS, '--flows', flows, '--report', report]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stderr, /verify ok/);
});

test('CLI verify rejects a tampered report', () => {
  const dir = tmp();
  const flows = join(ROOT, 'examples/flows.json');
  const report = join(dir, 'report.json');
  run(['settle', '--tzdb', TZDB, '--calendars', CALS, '--flows', flows, '--out', report]);
  const doc = JSON.parse(readFileSync(report, 'utf8'));
  doc.nets[0].net += 1;
  writeFileSync(report, JSON.stringify(doc));
  const r = run(['verify', '--tzdb', TZDB, '--calendars', CALS, '--flows', flows, '--report', report]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /verify FAILED/);
});

test('CLI exits 4 (E_GAP) on a spring-forward nonexistent local time', () => {
  const dir = tmp();
  const flows = writeFlows(dir, [{ ...baseFlow, localTime: '2024-03-10T02:30' }]);
  const r = run(['settle', '--tzdb', TZDB, '--calendars', CALS, '--flows', flows]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /E_GAP/);
});

test('CLI exits 5 (E_OVERLAP) on a fall-back ambiguous local time', () => {
  const dir = tmp();
  const flows = writeFlows(dir, [{ ...baseFlow, localTime: '2024-11-03T01:30' }]);
  const r = run(['settle', '--tzdb', TZDB, '--calendars', CALS, '--flows', flows]);
  assert.equal(r.status, 5);
  assert.match(r.stderr, /E_OVERLAP/);
});

test('CLI exits 3 (E_TZ_UNKNOWN) when a calendar references an unknown zone', () => {
  const dir = tmp();
  const cals = join(dir, 'calendars.json');
  writeFileSync(cals, JSON.stringify([{
    id: 'MARS', version: '1', zone: 'Mars/Olympus', cutoff: '17:00',
    weekend: [0, 6], holidays: [], horizon: '2025-12-31',
  }]));
  const flows = writeFlows(dir, [{ ...baseFlow, calendar: 'MARS' }]);
  const r = run(['settle', '--tzdb', TZDB, '--calendars', cals, '--flows', flows]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /E_TZ_UNKNOWN/);
});

test('CLI exits 6 (E_ORDER) on non-increasing seq across batches', () => {
  const dir = tmp();
  const f1 = writeFlows(dir, [baseFlow]);
  const state = join(dir, 'state.json');
  const r1 = run(['settle', '--tzdb', TZDB, '--calendars', CALS, '--flows', f1, '--state-out', state]);
  assert.equal(r1.status, 0, r1.stderr);
  const f2 = writeFlows(dir, [{ ...baseFlow, id: 't2', seq: 1, localTime: '2024-06-10T11:00' }]);
  const r2 = run(['settle', '--tzdb', TZDB, '--calendars', CALS, '--flows', f2, '--state-in', state, '--state-out', state]);
  assert.equal(r2.status, 6);
  assert.match(r2.stderr, /E_ORDER/);
});

test('CLI exits 2 (E_INPUT) on missing arguments', () => {
  const r = run(['settle', '--tzdb', TZDB]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_INPUT/);
});
