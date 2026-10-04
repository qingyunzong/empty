import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qcs-cli-'));
}

test('CLI end-to-end: init, report, dedup, correct, status, history, verify', () => {
  const dir = tmpDir();

  let res = runCli(['init', '--db', dir]);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).ok, true);

  const report = { clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.0, reportedAt: 1 };
  res = runCli(['report', '--db', dir, '--json', JSON.stringify(report)]);
  assert.equal(res.code, 0, res.stderr);
  let out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.deduplicated, false);
  assert.equal(out.status.judgment, 'OK');
  const recordId = out.record.recordId;

  res = runCli(['report', '--db', dir, '--json', JSON.stringify(report)]);
  assert.equal(res.code, 0, res.stderr);
  out = JSON.parse(res.stdout);
  assert.equal(out.deduplicated, true);
  assert.equal(out.record.recordId, recordId);

  const correction = { clientRecordId: 'c-2', correctsRecordId: recordId, value: 10.4, reportedAt: 2 };
  res = runCli(['correct', '--db', dir, '--json', JSON.stringify(correction)]);
  assert.equal(res.code, 0, res.stderr);
  out = JSON.parse(res.stdout);
  assert.equal(out.status.judgment, 'NG');

  res = runCli(['status', '--db', dir, '--lot', 'L1', '--test', 'DIM_LEN']);
  assert.equal(res.code, 0, res.stderr);
  out = JSON.parse(res.stdout);
  assert.equal(out.judgment, 'NG');
  assert.equal(out.totalRecords, 2);

  res = runCli(['history', '--db', dir, '--lot', 'L1', '--test', 'DIM_LEN']);
  assert.equal(res.code, 0, res.stderr);
  out = JSON.parse(res.stdout);
  assert.equal(out.records.length, 2);
  assert.equal(out.records[0].invalidatedBy, out.records[1].recordId);

  res = runCli(['verify', '--db', dir]);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).checked, 2);

  res = runCli(['verify', '--db', dir, '--record', recordId]);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).valid, true);

  res = runCli(['report', '--db', dir], { stdin: `${JSON.stringify({ clientRecordId: 'c-3', lotId: 'L2', testCode: 'WEIGHT', value: 50.0 })}\n` });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).status.judgment, 'OK');
});

test('CLI business errors exit 1 with JSON error on stderr', () => {
  const dir = tmpDir();
  runCli(['init', '--db', dir]);

  let res = runCli(['report', '--db', dir, '--json', JSON.stringify({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 99999 })]);
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'ERR_VALUE_OUT_OF_RANGE');

  res = runCli(['report', '--db', dir, '--json', JSON.stringify({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'NOPE', value: 1 })]);
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'ERR_UNKNOWN_TEST');

  res = runCli(['correct', '--db', dir, '--json', JSON.stringify({ clientRecordId: 'c-2', correctsRecordId: 'rec_missing', value: 1 })]);
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'ERR_UNKNOWN_REFERENCE');

  res = runCli(['status', '--db', path.join(dir, 'does-not-exist'), '--lot', 'L1', '--test', 'DIM_LEN']);
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'ERR_NOT_INITIALIZED');
});

test('CLI corruption exits 2', () => {
  const dir = tmpDir();
  runCli(['init', '--db', dir]);
  runCli(['report', '--db', dir, '--json', JSON.stringify({ clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10 })]);

  const walFile = path.join(dir, 'wal.log');
  const content = fs.readFileSync(walFile, 'utf8');
  fs.writeFileSync(walFile, content.replace('"value":10', '"value":99'));

  const res = runCli(['status', '--db', dir, '--lot', 'L1', '--test', 'DIM_LEN']);
  assert.equal(res.code, 2);
  assert.equal(JSON.parse(res.stderr).error.code, 'ERR_CORRUPT');
});

test('CLI fault injection: uncommitted record yields no judgment after recovery', () => {
  const dir = tmpDir();
  runCli(['init', '--db', dir]);
  const report = { clientRecordId: 'c-1', lotId: 'L1', testCode: 'DIM_LEN', value: 10.0 };

  let res = runCli(['report', '--db', dir, '--json', JSON.stringify(report)], { env: { QCS_FAULT: 'after-data-sync' } });
  assert.equal(res.code, 3);

  res = runCli(['status', '--db', dir, '--lot', 'L1', '--test', 'DIM_LEN']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).judgment, 'NO_DATA');

  res = runCli(['report', '--db', dir, '--json', JSON.stringify(report)], { env: { QCS_FAULT: 'after-commit-sync' } });
  assert.equal(res.code, 3);

  res = runCli(['status', '--db', dir, '--lot', 'L1', '--test', 'DIM_LEN']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).judgment, 'OK');

  res = runCli(['recover', '--db', dir]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.recovered.committed, 1);
  assert.equal(out.projection.recordCount, 1);
});
