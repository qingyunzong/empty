'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeEvents, tmpdir, writeLog, writeJson, runCli } = require('./helpers');

function setup() {
  const dir = tmpdir();
  const oldLog = writeLog(dir, 'old.jsonl', makeEvents(10));
  const fix = writeJson(dir, 'fix.json', {
    patchOps: [{ op: 'replaceBody', seq: 4, fields: { amount: 1 } }],
  });
  const out = path.join(dir, 'new.jsonl');
  const cert = path.join(dir, 'cert.json');
  return { dir, oldLog, fix, out, cert };
}

test('recover: crash after writing new.tmp -> OLD, old log authoritative, tmp cleanup advised', async () => {
  const { oldLog, fix, out, cert } = setup();
  const res = await runCli(['patch', oldLog, fix, '--out', out, '--cert', cert], {
    AUDIT_CRASH_AFTER: 'new-tmp',
  });
  assert.equal(res.status, 75); // simulated hard crash
  assert.ok(fs.existsSync(out + '.tmp'));
  assert.ok(!fs.existsSync(out));
  assert.ok(!fs.existsSync(cert));

  const rec = await runCli(['recover', '--out', out, '--cert', cert]);
  assert.equal(rec.status, 0, rec.stderr);
  assert.match(rec.stdout, /^OLD:/);
  assert.match(rec.stdout, /rollback: remove leftover temp files/);

  // old log still verifies; no mixed state
  assert.equal((await runCli(['verify', oldLog])).status, 0);
  fs.rmSync(out + '.tmp');
  const rec2 = await runCli(['recover', '--out', out, '--cert', cert]);
  assert.equal(rec2.status, 0);
  assert.match(rec2.stdout, /^OLD:/);
});

test('recover: crash after writing cert.tmp -> OLD (commit point not reached)', async () => {
  const { oldLog, fix, out, cert } = setup();
  const res = await runCli(['patch', oldLog, fix, '--out', out, '--cert', cert], {
    AUDIT_CRASH_AFTER: 'cert-tmp',
  });
  assert.equal(res.status, 75);
  assert.ok(fs.existsSync(out + '.tmp'));
  assert.ok(fs.existsSync(cert + '.tmp'));
  assert.ok(!fs.existsSync(out));
  assert.ok(!fs.existsSync(cert));

  const rec = await runCli(['recover', '--out', out, '--cert', cert]);
  assert.equal(rec.status, 0);
  assert.match(rec.stdout, /^OLD:/);
});

test('recover: crash between the two renames -> MIXED, rollback instruction, exit 2', async () => {
  const { oldLog, fix, out, cert } = setup();
  const res = await runCli(['patch', oldLog, fix, '--out', out, '--cert', cert], {
    AUDIT_CRASH_AFTER: 'rename-new',
  });
  assert.equal(res.status, 75);
  assert.ok(fs.existsSync(out)); // new log renamed...
  assert.ok(!fs.existsSync(cert)); // ...but cert commit never happened

  const rec = await runCli(['recover', '--out', out, '--cert', cert]);
  assert.equal(rec.status, 2);
  assert.match(rec.stderr, /^MIXED: partial commit/);
  assert.match(rec.stderr, /ROLLBACK required/);
  assert.match(rec.stderr, /never silently mixed/);

  // Follow the rollback instruction: remove partial outputs, old version restored.
  fs.rmSync(out);
  const rec2 = await runCli(['recover', '--out', out, '--cert', cert]);
  assert.equal(rec2.status, 0);
  assert.match(rec2.stdout, /^OLD:/);
  assert.equal((await runCli(['verify', oldLog])).status, 0);
});

test('recover: completed patch -> NEW, and check confirms consistency', async () => {
  const { oldLog, fix, out, cert } = setup();
  assert.equal((await runCli(['patch', oldLog, fix, '--out', out, '--cert', cert])).status, 0);
  const rec = await runCli(['recover', '--out', out, '--cert', cert]);
  assert.equal(rec.status, 0);
  assert.match(rec.stdout, /^NEW:/);
  assert.equal((await runCli(['check', oldLog, out, cert])).status, 0);
});

test('recover: both finals present but cert does not match new log -> MIXED exit 2', async () => {
  const { dir, oldLog, fix, out, cert } = setup();
  assert.equal((await runCli(['patch', oldLog, fix, '--out', out, '--cert', cert])).status, 0);
  // Simulate a bad recovery state: cert from a different patch run.
  const other = writeJson(dir, 'other-fix.json', {
    patchOps: [{ op: 'void', seq: 8, reason: 'x' }],
  });
  const out2 = path.join(dir, 'other-new.jsonl');
  const cert2 = path.join(dir, 'other-cert.json');
  assert.equal((await runCli(['patch', oldLog, other, '--out', out2, '--cert', cert2])).status, 0);
  fs.copyFileSync(cert2, cert); // mismatched cert over the committed new log
  const rec = await runCli(['recover', '--out', out, '--cert', cert]);
  assert.equal(rec.status, 2);
  assert.match(rec.stderr, /^MIXED: cert newRoot does not match/);
});
