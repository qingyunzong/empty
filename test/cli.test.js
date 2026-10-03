'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ev, tmpdir, writeFrames, runCli, runVerify } = require('./helpers');
const { encodeFrame, encodeFrames, withChecksum } = require('../lib/frame');

function readReport(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'report.json'), 'utf8'));
}

function readCerts(stateDir) {
  return fs.readdirSync(stateDir)
    .filter((f) => /^cert-.*\.json$/.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(stateDir, f), 'utf8'));
}

test('frame errors exit 2: half frame, bad length, bad checksum, unknown type', () => {
  const dir = tmpdir();
  const good = encodeFrame(ev('e1', 'A', 1, 1, 1));

  const half = path.join(dir, 'half.bin');
  fs.writeFileSync(half, good.subarray(0, good.length - 3));
  assert.equal(runCli(half, path.join(dir, 's1')).status, 2);

  const badLen = path.join(dir, 'badlen.bin');
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(1 << 30, 0);
  fs.writeFileSync(badLen, buf);
  assert.equal(runCli(badLen, path.join(dir, 's2')).status, 2);

  const badSum = path.join(dir, 'badsum.bin');
  const tampered = { ...ev('e1', 'A', 1, 1, 1), checksum: 'deadbeefdeadbeef' };
  fs.writeFileSync(badSum, encodeFrame(tampered));
  assert.equal(runCli(badSum, path.join(dir, 's3')).status, 2);

  const unknown = path.join(dir, 'unknown.bin');
  fs.writeFileSync(unknown, encodeFrame({ type: 'bogus' }));
  assert.equal(runCli(unknown, path.join(dir, 's4')).status, 2);
});

test('cli exits 3 on duplicate eventId with different payload', () => {
  const dir = tmpdir();
  const file = writeFrames(dir, [ev('e1', 'A', 1, 1, 1), ev('e1', 'A', 2, 1, 1)]);
  assert.equal(runCli(file, path.join(dir, 's')).status, 3);
});

test('cli exits 4 on missing sequence beyond window', () => {
  const dir = tmpdir();
  const file = writeFrames(dir, [ev('e1', 'A', 1, 1, 1), ev('e10', 'A', 1, 10, 10)]);
  assert.equal(runCli(file, path.join(dir, 's')).status, 4);
});

test('close boundary: late event goes to next period, frozen balances stay (acceptance 3)', () => {
  const dir = tmpdir();
  const state = path.join(dir, 's');
  const frames = [
    ev('e1', 'A', 100, 1, 1),
    { type: 'close' },
    ev('e2', 'A', 5, 2, 1),
  ];
  const file = writeFrames(dir, frames);
  const res = runCli(file, state);
  assert.equal(res.status, 0, res.stderr);
  const certs = readCerts(state).map((c) => JSON.parse(c));
  assert.equal(certs.length, 2);
  assert.equal(certs[0].balances.A, 100);
  assert.equal(certs[1].balances.A, 105);
  assert.deepEqual(certs[1].events.map((e) => e.eventId), ['e2']);
  assert.equal(certs[1].prevBalances.A, 100);
});

test('crash recovery at all four failure points is idempotent (acceptance 4)', () => {
  const dir = tmpdir();
  const frames = [
    ev('e1', 'A', 100, 1, 1),
    ev('e2', 'A', -30, 2, 2),
    ev('e2', 'A', -30, 2, 2),
    ev('e3', 'B', 50, 1, 3),
    { type: 'close' },
    ev('e4', 'A', 0, 3, 4, { reversalOf: 'e1' }),
    ev('e5', 'A', 60, 4, 5, { replaces: 'e1' }),
    ev('e6', 'B', 7, 2, 6),
  ];
  const file = writeFrames(dir, frames);

  const cleanDir = path.join(dir, 'clean');
  const clean = runCli(file, cleanDir);
  assert.equal(clean.status, 0, clean.stderr);
  const wantReport = readReport(cleanDir);
  const wantCerts = readCerts(cleanDir);

  const crashAfter = { recv: '3', log: '3', balance: '3', cert: '2' };
  for (const point of ['recv', 'log', 'balance', 'cert']) {
    const state = path.join(dir, `crash-${point}`);
    const crashed = runCli(file, state, { LEDGER_CRASH_AT: point, LEDGER_CRASH_AFTER: crashAfter[point] });
    assert.equal(crashed.status, 99, `expected crash at ${point}`);
    const recovered = runCli(file, state);
    assert.equal(recovered.status, 0, `recovery at ${point}: ${recovered.stderr}`);
    assert.deepEqual(readReport(state), wantReport, `report mismatch after ${point} crash`);
    assert.deepEqual(readCerts(state), wantCerts, `cert mismatch after ${point} crash`);
  }
});

test('verify.js accepts a genuine cert and rejects tampering', () => {
  const dir = tmpdir();
  const state = path.join(dir, 's');
  const file = writeFrames(dir, [ev('e1', 'A', 42, 1, 1), ev('e2', 'B', -2, 1, 2)]);
  assert.equal(runCli(file, state).status, 0);
  const certFile = path.join(state, 'cert-1.json');
  const ok = runVerify(certFile);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^OK period=1/);

  const cert = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  cert.balances.A = 999;
  const tamperedFile = path.join(dir, 'tampered.json');
  fs.writeFileSync(tamperedFile, JSON.stringify(cert));
  const bad = runVerify(tamperedFile);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^FAIL/);

  const cert2 = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  cert2.merkleRoot = '0'.repeat(64);
  const tampered2 = path.join(dir, 'tampered2.json');
  fs.writeFileSync(tampered2, JSON.stringify(cert2));
  assert.equal(runVerify(tampered2).status, 1);
});

test('restart with the same input file is a no-op (idempotent recovery)', () => {
  const dir = tmpdir();
  const state = path.join(dir, 's');
  const e1 = withChecksum({ eventId: 'e1', acct: 'A', amount: 10, branchSeq: 1, logicalTs: 1 });
  const f1 = path.join(dir, 'f1.bin');
  fs.writeFileSync(f1, encodeFrames([e1]));
  assert.equal(runCli(f1, state).status, 0);
  const again = runCli(f1, state);
  assert.equal(again.status, 0);
  assert.match(again.stderr, /resuming: 1 frame/);
  const report = readReport(state);
  assert.equal(report.balances.A, 10);
  assert.equal(report.duplicates, 0);
});
