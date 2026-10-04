'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run: cliRun } = require('../cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sample-cache-cli-'));
}

function run(cwd, args) {
  const prev = process.cwd();
  const out = [];
  const errs = [];
  process.chdir(cwd);
  let status;
  try {
    status = cliRun(args, {
      stdout: (s) => out.push(s),
      stderr: (s) => errs.push(s),
    });
  } finally {
    process.chdir(prev);
  }
  return { status, stdout: out.join(''), stderr: errs.join('') };
}

function ok(cwd, args) {
  const res = run(cwd, args);
  assert.equal(res.status, 0, `expected success, stderr: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function err(cwd, args) {
  const res = run(cwd, args);
  assert.equal(res.status, 1, `expected failure, stdout: ${res.stdout}`);
  return JSON.parse(res.stderr);
}

test('CLI: ingest / certify / checkCert / correctRange / invalidate flow', () => {
  const dir = tmpdir();
  const source = path.join(dir, 'sample.bin');
  const data = Buffer.alloc(10 * 32);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 7) % 256;
  fs.writeFileSync(source, data);

  const info = ok(dir, ['ingest', 'sample', source, '--chunk', '32', '--capacity', '4096']);
  assert.equal(info.blockCount, 10);

  const certPath = path.join(dir, 'cert.json');
  ok(dir, ['certify', 'sample', '0', '9', '--out', 'cert.json']);
  const cert = JSON.parse(fs.readFileSync(certPath, 'utf8'));
  assert.equal(cert.generation, 1);
  assert.equal(cert.bitmap, '1111111111');

  const accepted = ok(dir, ['checkCert', 'sample', 'cert.json']);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.covered, 10);

  data[3 * 32] ^= 0xff;
  fs.writeFileSync(source, data);
  ok(dir, ['correctRange', 'sample', '3', '3']);

  const stale = err(dir, ['checkCert', 'sample', 'cert.json']);
  assert.equal(stale.error, 'ERR_STALE');

  ok(dir, ['certify', 'sample', '0', '9', '--out', 'cert2.json']);
  const cert2 = JSON.parse(fs.readFileSync(path.join(dir, 'cert2.json'), 'utf8'));
  assert.equal(cert2.generation, 2);
  assert.equal(cert2.bitmap, '0001000000');
  assert.equal(ok(dir, ['checkCert', 'sample', 'cert2.json']).ok, true);

  const invalidated = ok(dir, ['invalidate', 'sample', '0', '9']);
  assert.equal(invalidated.invalidated, 10);
  assert.equal(ok(dir, ['checkCert', 'sample', 'cert2.json']).ok, true);
});

test('CLI: source and cache both corrupt yields ERR_SOURCE JSON on stderr', () => {
  const dir = tmpdir();
  const source = path.join(dir, 'sample.bin');
  const data = Buffer.alloc(4 * 32, 0x5a);
  fs.writeFileSync(source, data);

  ok(dir, ['ingest', 'sample', source, '--chunk', '32']);
  ok(dir, ['certify', 'sample', '0', '3', '--out', 'cert.json']);

  ok(dir, ['invalidate', 'sample']);
  data[40] ^= 0xff;
  fs.writeFileSync(source, data);

  const res = err(dir, ['checkCert', 'sample', 'cert.json']);
  assert.equal(res.error, 'ERR_SOURCE');
});

test('CLI: bad ranges and unknown samples yield ERR_RANGE', () => {
  const dir = tmpdir();
  const source = path.join(dir, 'sample.bin');
  fs.writeFileSync(source, Buffer.alloc(64, 1));
  ok(dir, ['ingest', 'sample', source, '--chunk', '32']);

  assert.equal(err(dir, ['certify', 'sample', '0', '7']).error, 'ERR_RANGE');
  assert.equal(err(dir, ['certify', 'ghost', '0', '1']).error, 'ERR_RANGE');
  assert.equal(err(dir, ['correctRange', 'sample', '2', '1']).error, 'ERR_RANGE');
});

test('CLI: merge command merges adjacent same-generation certs only', () => {
  const dir = tmpdir();
  const source = path.join(dir, 'sample.bin');
  fs.writeFileSync(source, Buffer.alloc(6 * 16, 3));
  ok(dir, ['ingest', 'sample', source, '--chunk', '16']);
  ok(dir, ['certify', 'sample', '0', '2', '--out', 'a.json']);
  ok(dir, ['certify', 'sample', '3', '5', '--out', 'b.json']);

  const merged = ok(dir, ['merge', 'a.json', 'b.json']);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].window, { start: 0, end: 5 });
  fs.writeFileSync(path.join(dir, 'merged.json'), JSON.stringify(merged[0]));
  assert.equal(ok(dir, ['checkCert', 'sample', 'merged.json']).ok, true);

  ok(dir, ['certify', 'sample', '1', '3', '--out', 'c.json']);
  const kept = ok(dir, ['merge', 'a.json', 'c.json']);
  assert.equal(kept.length, 2);
});
