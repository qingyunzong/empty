'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../src/cli.js');

const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const HALF_HOUR = 30 * 60 * 1000;

function writeJsonl(lines) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dives-')),
    'dives.jsonl'
  );
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

// Invoke the CLI entry point in-process, capturing stdout/stderr and the
// exit code that `node src/cli.js ...` would produce.
function runCli(args) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    stdoutChunks.push(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    stderrChunks.push(chunk);
    return true;
  };
  let status;
  try {
    status = main(['node', 'src/cli.js', ...args]);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { status, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

test('cli: clean run emits JSONL results on stdout and exits 0', () => {
  const file = writeJsonl([
    { type: 'UPSERT', profileId: 'p1', depth: 30, temp: 21, version: 1, time: T0 },
    { type: 'UPSERT', profileId: 'p1', depth: 10, temp: 20, version: 1, time: T0 + 1000 },
    { type: 'UPSERT', profileId: 'p1', depth: 20, temp: 20.2, version: 1, time: T0 + 2000 },
    { type: 'WATERMARK', time: T0 + 2000 + HALF_HOUR + 1 },
  ]);
  const res = runCli(['profiles', '--in', file]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  const rows = res.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter((r) => r.type === 'UPSERT_OK').length, 3);
  const cert = rows.find((r) => r.type === 'CERTIFICATE');
  assert.ok(cert);
  assert.deepEqual(cert.depths, [10, 20, 30]);
  assert.deepEqual(cert.inversions, [[20, 30]]);
  assert.deepEqual(cert.maxInversion, { top: 20, bottom: 30, span: 10 });
  assert.deepEqual(cert.missing.blocks, [[11, 19], [21, 29]]);
});

test('cli: late correction after close goes to stderr as JSON, exit code 2', () => {
  const file = writeJsonl([
    { type: 'UPSERT', profileId: 'p1', depth: 10, temp: 20, version: 1, time: T0 },
    { type: 'WATERMARK', time: T0 + HALF_HOUR + 1 },
    { type: 'UPSERT', profileId: 'p1', depth: 20, temp: 21, version: 1, time: T0 + 2 * HALF_HOUR },
  ]);
  const res = runCli(['profiles', '--in', file]);
  assert.equal(res.status, 2);
  const errRows = res.stderr.trim().split('\n').map(JSON.parse);
  assert.equal(errRows.length, 1);
  assert.equal(errRows[0].type, 'ERROR');
  assert.equal(errRows[0].code, 'LATE');
  // The certificate was still published on stdout before the late event.
  const rows = res.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter((r) => r.type === 'CERTIFICATE').length, 1);
});

test('cli: stale version and unknown retract surface as stderr JSON', () => {
  const file = writeJsonl([
    { type: 'UPSERT', profileId: 'p1', depth: 10, temp: 20, version: 2, time: T0 },
    { type: 'UPSERT', profileId: 'p1', depth: 10, temp: 21, version: 1, time: T0 + 1000 },
    { type: 'RETRACT', profileId: 'p1', depth: 99, version: 1, time: T0 + 2000 },
  ]);
  const res = runCli(['profiles', '--in', file]);
  assert.equal(res.status, 2);
  const codes = res.stderr.trim().split('\n').map((l) => JSON.parse(l).code);
  assert.deepEqual(codes, ['STALE_VERSION', 'UNKNOWN_RETRACT']);
});

test('cli: invalid JSON line is reported and processing continues', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dives-'));
  const file = path.join(dir, 'dives.jsonl');
  fs.writeFileSync(
    file,
    '{"type":"UPSERT","profileId":"p1","depth":10,"temp":20,"version":1,"time":0}\n' +
      'not json\n' +
      '{"type":"WATERMARK","time":' + (HALF_HOUR + 1) + '}\n'
  );
  const res = runCli(['profiles', '--in', file]);
  assert.equal(res.status, 2);
  const errRows = res.stderr.trim().split('\n').map(JSON.parse);
  assert.equal(errRows[0].code, 'INVALID_JSON');
  const rows = res.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter((r) => r.type === 'CERTIFICATE').length, 1);
});

test('cli: missing input file exits 2 with IO_ERROR', () => {
  const res = runCli(['profiles', '--in', '/nonexistent/dives.jsonl']);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr.trim()).code, 'IO_ERROR');
});

test('cli: bad usage exits 2 with USAGE error', () => {
  let res = runCli([]);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr.trim()).code, 'USAGE');
  res = runCli(['profiles']);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr.trim()).code, 'USAGE');
});
