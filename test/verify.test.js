'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ev, close, writeFrames, runCli, runVerify, tmpdir } = require('./helpers');

function certified() {
  const { file } = writeFrames([
    ev('e1', 'A', 100, 1, 10),
    ev('e2', 'B', -40, 1, 20),
    close('P1', 100),
    ev('e3', 'A', 60, 2, 110, { replaces: 'e1' }),
  ]);
  const state = path.join(tmpdir(), 's');
  const r = runCli(file, { state });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('certificate verifies: leaves, root, balance replay', () => {
  const out = certified();
  for (const p of out.periods) {
    const v = runVerify(p.cert);
    assert.equal(v.status, 0, v.stdout);
    const res = JSON.parse(v.stdout);
    assert.equal(res.ok, true);
    assert.deepEqual(res.checks, { leaves: true, root: true, balances: true });
    assert.equal(res.root, p.root);
  }
});

test('tampered certificate fails verification', () => {
  const out = certified();
  const certPath = out.periods[0].cert;
  const cert = JSON.parse(fs.readFileSync(certPath, 'utf8'));
  cert.balances.A = 999999;
  const tampered = path.join(tmpdir(), 'cert.json');
  fs.writeFileSync(tampered, JSON.stringify(cert));
  const v = runVerify(tampered);
  assert.equal(v.status, 1);
  assert.equal(JSON.parse(v.stdout).checks.balances, false);
});

test('tampered log entry breaks leaf hashes and root', () => {
  const out = certified();
  const cert = JSON.parse(fs.readFileSync(out.periods[0].cert, 'utf8'));
  cert.log[0].amount += 1;
  const tampered = path.join(tmpdir(), 'cert.json');
  fs.writeFileSync(tampered, JSON.stringify(cert));
  const v = runVerify(tampered);
  assert.equal(v.status, 1);
  const checks = JSON.parse(v.stdout).checks;
  assert.equal(checks.leaves, false);
  assert.equal(checks.root, false);
});
