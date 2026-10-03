'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/cli');

const DAY = '2026-10-04';

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'eod-cli-')); }

function writeJson(dir, name, value) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(value));
  return p;
}

const entry = (id, over = {}) => ({
  id, accountId: 'a1', day: DAY, amount: 100, currency: 'CNY', status: 'settled', ...over,
});

test('reconcile command prints report with repaired/pending/conflicts/auditRoot', () => {
  const dir = tmpdir();
  const ledger = writeJson(dir, 'ledger.json', [entry('t1'), entry('t2', { amount: 5 })]);
  const snapshot = writeJson(dir, 'snapshot.json', [entry('t1', { amount: 90 })]);
  const { code, output } = run(['reconcile',
    '--ledger', ledger, '--snapshot', snapshot, '--slots', '2']);
  assert.equal(code, 0);
  const report = JSON.parse(output);
  assert.ok(Array.isArray(report.repaired));
  assert.ok(Array.isArray(report.pending));
  assert.ok(Array.isArray(report.conflicts));
  assert.match(report.auditRoot, /^[0-9a-f]{64}$/);
  assert.equal(report.repaired.length, 2); // amount fix + missing-in-snapshot
});

test('ingest on sealed day exits 1 with SEALED error', () => {
  const dir = tmpdir();
  const ledger = writeJson(dir, 'ledger.json', [entry('late')]);
  const { code, output } = run(['ingest', '--ledger', ledger, '--seal', `a1:${DAY}`]);
  assert.equal(code, 1);
  assert.equal(JSON.parse(output).error, 'SEALED');
});

test('undo via CLI after recovery restores snapshot bytes', () => {
  const dir = tmpdir();
  const stateDir = path.join(dir, 'state');
  const ledger = writeJson(dir, 'ledger.json', [entry('t1')]);
  const snapshot = writeJson(dir, 'snapshot.json', [entry('t1', { amount: 90 })]);
  assert.equal(run(['reconcile', '--ledger', ledger, '--snapshot', snapshot,
    '--state-dir', stateDir]).code, 0);
  const { code, output } = run(['undo', '--state-dir', stateDir, '--task', 'task-1']);
  assert.equal(code, 0);
  const result = JSON.parse(output);
  assert.equal(result.restored, true);
  assert.ok(result.snapshotBytes.includes('"amount":90')); // pre-repair value restored
});

test('report command replays journal idempotently', () => {
  const dir = tmpdir();
  const stateDir = path.join(dir, 'state');
  const ledger = writeJson(dir, 'ledger.json', [entry('t1')]);
  const snapshot = writeJson(dir, 'snapshot.json', [entry('t1', { amount: 90 })]);
  run(['reconcile', '--ledger', ledger, '--snapshot', snapshot, '--state-dir', stateDir]);
  const first = JSON.parse(run(['report', '--state-dir', stateDir]).output);
  const second = JSON.parse(run(['report', '--state-dir', stateDir]).output);
  assert.deepEqual(first.repaired, ['task-1']);
  assert.deepEqual(first, second); // idempotent replay
});

test('bad diff input exits 1 with BAD_DIFF', () => {
  const dir = tmpdir();
  const ledger = writeJson(dir, 'ledger.json', [{ id: 42 }]);
  const { code, output } = run(['reconcile', '--ledger', ledger]);
  assert.equal(code, 1);
  assert.equal(JSON.parse(output).error, 'BAD_DIFF');
});

test('no command prints usage with exit code 2', () => {
  const { code, output } = run([]);
  assert.equal(code, 2);
  assert.match(output, /usage: eod-reconcile/);
});
