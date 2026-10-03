import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.js';
import { verifyProof } from '../src/hash.js';
import { runCli, stdoutLines } from '../testlib/cli-runner.js';

const OPS = [
  { op: 'snapshot', id: 'fx1', pair: 'USD/CNY', rate: 2 },
  { op: 'voucher', id: 'v1', entries: [{ account: 'cash', amount: 100 }, { account: 'rev', amount: -100 }] },
  { op: 'voucher', id: 'v2', entries: [{ account: 'cash', amount: 5, currency: 'USD', snapshot: 'fx1' }, { account: 'rev', amount: -10 }], deps: ['v1'] },
  { op: 'voucher', id: 'bx', entries: [{ account: 'cash', amount: 7 }, { account: 'rev', amount: -7 }], pos: 1.5 },
  { op: 'reverse', id: 'r1', target: 'v1' },
  { op: 'proof', id: 'v1' },
  { op: 'root' },
];

function referenceRun() {
  const ledger = new Ledger();
  ledger.addSnapshot({ id: 'fx1', pair: 'USD/CNY', rate: 2 });
  ledger.addVoucher({ id: 'v1', entries: [{ account: 'cash', amount: 100 }, { account: 'rev', amount: -100 }] });
  ledger.addVoucher({ id: 'v2', entries: [{ account: 'cash', amount: 5, currency: 'USD', snapshot: 'fx1' }, { account: 'rev', amount: -10 }], deps: ['v1'] });
  ledger.addVoucher({ id: 'bx', entries: [{ account: 'cash', amount: 7 }, { account: 'rev', amount: -7 }], pos: 1.5 });
  ledger.reverse({ id: 'r1', target: 'v1' });
  return ledger;
}

test('cli processes JSONL and emits per-step root, invalidation set and proof', () => {
  const run = runCli({ input: OPS.map((o) => JSON.stringify(o)).join('\n') + '\n' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const lines = stdoutLines(run);
  assert.equal(lines.length, OPS.length);
  const ledger = referenceRun();

  const voucherStep = lines[1];
  assert.equal(voucherStep.op, 'voucher');
  assert.equal(voucherStep.id, 'v1');
  assert.equal(voucherStep.lamport, 1);
  assert.ok(Array.isArray(voucherStep.invalid));
  assert.ok(Array.isArray(voucherStep.proof));

  const insertStep = lines[3];
  assert.deepEqual(insertStep.invalid, ['v2']);

  const reverseStep = lines[4];
  assert.equal(reverseStep.root, ledger.root);
  assert.deepEqual(reverseStep.invalid, ledger.invalidIds());

  const proofStep = lines[5];
  assert.equal(proofStep.valid, true);
  const record = ledger.vouchers.get('v1');
  assert.ok(verifyProof(record.hash, proofStep.proof, proofStep.root));
  assert.ok(ledger.invalidIds().includes('bx'));

  const rootStep = lines[6];
  assert.equal(rootStep.root, ledger.root);
  assert.deepEqual(rootStep.balances, Object.fromEntries([...ledger.balances.entries()].sort()));
});

test('cli reports MISSING_SNAPSHOT on stderr with exit code 3', () => {
  const run = runCli({
    input: JSON.stringify({ op: 'voucher', id: 'v1', entries: [{ account: 'c', amount: 1, currency: 'USD', snapshot: 'nope' }] }) + '\n',
  });
  assert.equal(run.status, 3);
  assert.equal(run.stdout, '');
  const err = JSON.parse(run.stderr.trim());
  assert.equal(err.error, 'MISSING_SNAPSHOT');
  assert.equal(err.step, 1);
});

test('cli reports MISSING_DEPENDENCY and DUPLICATE_ID with exit code 3', () => {
  const run1 = runCli({
    input: JSON.stringify({ op: 'voucher', id: 'v1', entries: [{ account: 'c', amount: 1 }], deps: ['ghost'] }) + '\n',
  });
  assert.equal(run1.status, 3);
  assert.equal(JSON.parse(run1.stderr.trim()).error, 'MISSING_DEPENDENCY');

  const run2 = runCli({
    input: [
      { op: 'voucher', id: 'v1', entries: [{ account: 'c', amount: 1 }] },
      { op: 'voucher', id: 'v1', entries: [{ account: 'c', amount: 2 }] },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n',
  });
  assert.equal(run2.status, 3);
  assert.equal(JSON.parse(run2.stderr.trim()).error, 'DUPLICATE_ID');
});

test('cli detects broken chain on state reload, refuses mutation, recovers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-chain-'));
  const setup = runCli({
    input: [
      { op: 'voucher', id: 'v1', entries: [{ account: 'cash', amount: 10 }] },
      { op: 'voucher', id: 'v2', entries: [{ account: 'cash', amount: 20 }], deps: ['v1'] },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n',
    stateDir: dir,
  });
  assert.equal(setup.status, 0, setup.stderr);
  const goodRoot = stdoutLines(setup).at(-1).root;

  const logPath = path.join(dir, 'log.jsonl');
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  lines[1].record.hash = '0'.repeat(64);
  fs.writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const verifyRun = runCli({ input: JSON.stringify({ op: 'verify' }) + '\n', stateDir: dir });
  assert.equal(verifyRun.status, 3);
  const report = stdoutLines(verifyRun).at(-1);
  assert.equal(report.ok, false);
  assert.equal(report.chain, 'broken');
  assert.equal(report.brokenAt[0].id, 'v2');

  const mutateRun = runCli({
    input: JSON.stringify({ op: 'voucher', id: 'v3', entries: [{ account: 'cash', amount: 1 }] }) + '\n',
    stateDir: dir,
  });
  assert.equal(mutateRun.status, 3);
  assert.equal(JSON.parse(mutateRun.stderr.trim()).error, 'BROKEN_CHAIN');

  const recoverRun = runCli({ input: JSON.stringify({ op: 'recover' }) + '\n', stateDir: dir });
  assert.equal(recoverRun.status, 0);
  assert.equal(stdoutLines(recoverRun).at(-1).recovered, true);

  const verifyAgain = runCli({ input: JSON.stringify({ op: 'verify' }) + '\n', stateDir: dir });
  assert.equal(verifyAgain.status, 0);
  const okReport = stdoutLines(verifyAgain).at(-1);
  assert.equal(okReport.ok, true);
  assert.equal(okReport.root, goodRoot);
});
