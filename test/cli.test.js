import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { tmpDir } from './helpers.js';

function run(args) {
  let out = '';
  let err = '';
  const code = runCli(args, { stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
  return {
    code,
    stdout: out ? JSON.parse(out) : null,
    stderr: err ? JSON.parse(err) : null
  };
}

test('CLI happy path: init, report, status, certs, verify', () => {
  const dir = tmpDir();
  const init = run(['init', '--dir', dir]);
  assert.equal(init.code, 0);
  assert.equal(init.stdout.ok, true);

  const report = run(['report', '--dir', dir, '--json', '{"clientRecordId":"c-1","lotId":"LOT-A","testCode":"dimension.length","value":10.0}']);
  assert.equal(report.code, 0);
  assert.equal(report.stdout.judgment, 'OK');
  assert.equal(report.stdout.recordId, 'rec-00000001');

  const status = run(['status', '--dir', dir, '--lot', 'LOT-A', '--test', 'dimension.length']);
  assert.equal(status.stdout.judgment, 'OK');

  const certs = run(['certs', '--dir', dir]);
  assert.equal(certs.stdout.certificates.length, 1);

  const verify = run(['verify', '--dir', dir]);
  assert.equal(verify.stdout.ok, true);
  assert.equal(verify.stdout.checked, 1);
});

test('CLI duplicate report exits 0 with duplicate flag and single certificate', () => {
  const dir = tmpDir();
  run(['init', '--dir', dir]);
  const payload = '{"clientRecordId":"c-1","lotId":"LOT-A","testCode":"dimension.length","value":10.0}';
  run(['report', '--dir', dir, '--json', payload]);
  const dup = run(['report', '--dir', dir, '--json', payload]);
  assert.equal(dup.code, 0);
  assert.equal(dup.stdout.duplicate, true);
  const certs = run(['certs', '--dir', dir]);
  assert.equal(certs.stdout.certificates.length, 1);
});

test('CLI correction flow updates status and keeps old cert verifiable', () => {
  const dir = tmpDir();
  run(['init', '--dir', dir]);
  run(['report', '--dir', dir, '--json', '{"clientRecordId":"c-1","lotId":"LOT-A","testCode":"dimension.length","value":10.0}']);
  const fix = run(['correct', '--dir', dir, '--json', '{"clientRecordId":"c-2","correctsRecordId":"rec-00000001","value":10.5}']);
  assert.equal(fix.stdout.judgment, 'NG');

  const status = run(['status', '--dir', dir, '--lot', 'LOT-A', '--test', 'dimension.length']);
  assert.equal(status.stdout.judgment, 'NG');
  assert.equal(status.stdout.recordId, 'rec-00000002');

  const oldCert = run(['verify', '--dir', dir, '--id', 'rec-00000001']);
  assert.equal(oldCert.stdout.ok, true);
  const chain = run(['verify', '--dir', dir]);
  assert.equal(chain.stdout.checked, 2);
});

test('CLI business errors exit 1', () => {
  const dir = tmpDir();
  run(['init', '--dir', dir]);

  const unknownTest = run(['report', '--dir', dir, '--json', '{"clientRecordId":"c-1","lotId":"LOT-A","testCode":"nope","value":1}']);
  assert.equal(unknownTest.code, 1);
  assert.equal(unknownTest.stderr.error.code, 'UNKNOWN_TEST_CODE');

  const outOfRange = run(['report', '--dir', dir, '--json', '{"clientRecordId":"c-2","lotId":"LOT-A","testCode":"dimension.length","value":500}']);
  assert.equal(outOfRange.code, 1);
  assert.equal(outOfRange.stderr.error.code, 'VALUE_OUT_OF_RANGE');

  const unknownRecord = run(['correct', '--dir', dir, '--json', '{"clientRecordId":"c-3","correctsRecordId":"rec-99999999","value":10.0}']);
  assert.equal(unknownRecord.code, 1);
  assert.equal(unknownRecord.stderr.error.code, 'UNKNOWN_RECORD');

  const notInit = run(['status', '--dir', path.join(dir, 'missing'), '--lot', 'L', '--test', 'dimension.length']);
  assert.equal(notInit.code, 1);
  assert.equal(notInit.stderr.error.code, 'NOT_INITIALIZED');
});

test('CLI corruption exits 2', () => {
  const dir = tmpDir();
  run(['init', '--dir', dir]);
  run(['report', '--dir', dir, '--json', '{"clientRecordId":"c-1","lotId":"LOT-A","testCode":"dimension.length","value":10.0}']);
  fs.appendFileSync(path.join(dir, 'wal.log'), 'garbage-line\n');
  const res = run(['status', '--dir', dir, '--lot', 'LOT-A', '--test', 'dimension.length']);
  assert.equal(res.code, 2);
  assert.equal(res.stderr.error.code, 'CORRUPTION');
});
