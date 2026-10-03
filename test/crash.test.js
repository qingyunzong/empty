// Acceptance 4: crash in the middle of certificate write, then restart + verify.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.js';
import { runCli } from '../testlib/cli-runner.js';
import { buildCertificate, writeCertificate, certificateStatus, verifyCertificate } from '../src/certificate.js';

function makeLedger() {
  const ledger = new Ledger();
  ledger.addVoucher({ id: 'v1', entries: [{ account: 'cash', amount: 100 }, { account: 'rev', amount: -100 }] });
  ledger.addVoucher({ id: 'v2', entries: [{ account: 'cash', amount: 50 }, { account: 'rev', amount: -50 }], deps: ['v1'] });
  ledger.reverse({ id: 'r1', target: 'v1' });
  return ledger;
}

test('library: crash after tmp write leaves incomplete certificate, rewrite recovers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  const file = path.join(dir, 'cert.json');
  const ledger = makeLedger();
  const cert = buildCertificate(ledger);

  assert.throws(() => writeCertificate(file, cert, { crashAfter: 'tmp' }), /simulated crash/);
  assert.ok(fs.existsSync(file + '.tmp'));
  assert.ok(!fs.existsSync(file));
  assert.equal(certificateStatus(file, ledger), 'incomplete');

  const result = writeCertificate(file, cert);
  assert.equal(result.recovered, true);
  assert.equal(certificateStatus(file, ledger), 'ok');
  assert.ok(verifyCertificate(JSON.parse(fs.readFileSync(file, 'utf8')), ledger).ok);

  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.root = '0'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(tampered));
  assert.equal(certificateStatus(file, ledger), 'mismatch');
});

test('cli: crash mid-certificate, restart detects incomplete, rewrite verifies ok', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-state-'));
  const certFile = path.join(dir, 'cert.json');
  const vouchers = [
    { op: 'voucher', id: 'v1', entries: [{ account: 'cash', amount: 100 }] },
    { op: 'voucher', id: 'v2', entries: [{ account: 'cash', amount: 50 }], deps: ['v1'] },
  ];

  const run1 = runCli({
    input: [...vouchers, { op: 'certificate', file: certFile }].map((o) => JSON.stringify(o)).join('\n') + '\n',
    stateDir: dir,
    env: { LEDGER_CRASH_AFTER: 'tmp' },
  });
  assert.equal(run1.status, 1);
  assert.match(run1.stderr, /CRASH_SIMULATED/);
  assert.ok(fs.existsSync(certFile + '.tmp'));
  assert.ok(!fs.existsSync(certFile));

  const run2 = runCli({ input: JSON.stringify({ op: 'verify', cert: certFile }) + '\n', stateDir: dir });
  assert.equal(run2.status, 3);
  const report = JSON.parse(run2.stdout.trim().split('\n').at(-1));
  assert.equal(report.ok, false);
  assert.equal(report.certificate, 'incomplete');
  assert.equal(report.chain, 'ok');

  const run3 = runCli({ input: JSON.stringify({ op: 'certificate', file: certFile }) + '\n', stateDir: dir });
  assert.equal(run3.status, 0);
  const certOut = JSON.parse(run3.stdout.trim().split('\n').at(-1));
  assert.equal(certOut.recovered, true);

  const run4 = runCli({ input: JSON.stringify({ op: 'verify', cert: certFile }) + '\n', stateDir: dir });
  assert.equal(run4.status, 0);
  const okReport = JSON.parse(run4.stdout.trim().split('\n').at(-1));
  assert.equal(okReport.ok, true);
  assert.equal(okReport.certificate, 'ok');
  assert.equal(okReport.root, certOut.root);
});
