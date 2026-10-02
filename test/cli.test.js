'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cal-cli-'));
}

function run(dir, args) {
  const r = runCli(['--dir', dir, ...args]);
  return { code: r.code, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, err: r.stderr };
}

function setupLab(dir) {
  assert.equal(run(dir, ['add_artifact', '--id', 'ROOT', '--kind', 'standard', '--root', '--range-class', 'R1', '--env-class', 'E1', '--grade', 'G1', '--uncertainty', '0.001']).code, 0);
  assert.equal(run(dir, ['add_artifact', '--id', 'S1', '--kind', 'standard', '--range-class', 'R1', '--env-class', 'E1', '--grade', 'G1', '--uncertainty', '0.005', '--valid-from', '2025-01-01', '--valid-to', '2028-01-01']).code, 0);
  assert.equal(run(dir, ['add_artifact', '--id', 'U1', '--kind', 'uut', '--range-class', 'R1', '--env-class', 'E1', '--grade', 'G1']).code, 0);
  assert.equal(run(dir, ['add_artifact', '--id', 'P1', '--kind', 'point', '--uut', 'U1', '--range-class', 'R1', '--env-class', 'E1', '--grade', 'G1', '--budget', '0.02', '--window', '{"tempMin":18,"tempMax":26,"humMin":30,"humMax":60}']).code, 0);
  assert.equal(run(dir, ['link', '--from', 'U1', '--to', 'S1']).code, 0);
  assert.equal(run(dir, ['link', '--from', 'S1', '--to', 'ROOT']).code, 0);
}

test('cli end-to-end: build lab, measure, certify, audit', () => {
  const dir = tmpdir();
  setupLab(dir);

  const m = run(dir, ['measure', '--point', 'P1', '--value', '10.001', '--temp', '21', '--humidity', '45', '--u-meas', '0.002', '--at', '2026-10-01']);
  assert.equal(m.code, 0);
  assert.equal(m.out.id, 'M-1');
  // measure persists only via the journal; state.json must not hold measurements
  assert.ok(fs.existsSync(path.join(dir, 'measure.journal')));
  if (fs.existsSync(path.join(dir, 'state.json'))) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).measurements, undefined);
  }

  // unlink is blocked while the measurement is pending
  const blocked = run(dir, ['unlink', '--from', 'S1', '--to', 'ROOT']);
  assert.equal(blocked.code, 1);
  assert.equal(blocked.out.error, 'UNLINK_BLOCKED');

  // release without a lease -> LEASE_STATE
  const rel = run(dir, ['release', '--standard', 'S1', '--holder', 'nobody']);
  assert.equal(rel.code, 1);
  assert.equal(rel.out.error, 'LEASE_STATE');

  const c = run(dir, ['certify', '--point', 'P1', '--at', '2026-10-02']);
  assert.equal(c.code, 0);
  assert.equal(c.out.status, 'CERT');
  assert.deepEqual(c.out.cert.chain, ['ROOT', 'S1', 'U1']);

  const a = run(dir, ['audit', '--cert', c.out.cert.id]);
  assert.equal(a.code, 0);
  assert.equal(a.out.status, 'VALID');

  // after certification the measurement is no longer pending: unlink succeeds
  const un = run(dir, ['unlink', '--from', 'S1', '--to', 'ROOT']);
  assert.equal(un.code, 0);
});

test('cli: reserve/release pairing and PENDING while standard is busy', () => {
  const dir = tmpdir();
  setupLab(dir);
  run(dir, ['measure', '--point', 'P1', '--value', '10.001', '--temp', '21', '--humidity', '45', '--u-meas', '0.002']);
  assert.equal(run(dir, ['reserve', '--standard', 'S1', '--holder', 'job-1']).code, 0);
  const dup = run(dir, ['reserve', '--standard', 'S1', '--holder', 'job-2']);
  assert.equal(dup.code, 1);
  assert.equal(dup.out.error, 'LEASE_STATE');
  const p = run(dir, ['certify', '--point', 'P1', '--at', '2026-10-02']);
  assert.equal(p.out.status, 'PENDING');
  assert.equal(p.out.reason, 'STANDARD_BUSY');
  assert.equal(run(dir, ['release', '--standard', 'S1', '--holder', 'job-1']).code, 0);
  const c = run(dir, ['certify', '--point', 'P1', '--at', '2026-10-02']);
  assert.equal(c.out.status, 'CERT');
});

test('cli: crash recovery - torn journal tail never yields a half measure', () => {
  const dir = tmpdir();
  setupLab(dir);
  const m1 = run(dir, ['measure', '--point', 'P1', '--value', '10.001', '--temp', '21', '--humidity', '45']);
  assert.equal(m1.out.id, 'M-1');
  // simulate a crash mid-append: partial frame bytes at the journal tail
  fs.appendFileSync(path.join(dir, 'measure.journal'), Buffer.from([0x4d, 0x4a, 0x20, 0x00]));
  const m2 = run(dir, ['measure', '--point', 'P1', '--value', '10.002', '--temp', '22', '--humidity', '44']);
  assert.equal(m2.code, 0);
  assert.match(m2.err, /journal recovered/);
  assert.equal(m2.out.id, 'M-2'); // no half record consumed an id
  const c = run(dir, ['certify', '--point', 'P1', '--at', '2026-10-02']);
  assert.equal(c.out.status, 'CERT');
});

test('cli: unknown command exits with error code 1', () => {
  const dir = tmpdir();
  const r = run(dir, ['frobnicate']);
  assert.equal(r.code, 1);
  assert.equal(r.out.error, 'UNKNOWN_COMMAND');
});
