import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Wal } from '../src/index.js';
import { runCli } from '../bin/rev.js';
import { makeTxn, makeLedgerJson, makeWorkspace, writeJson } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/rev.js', import.meta.url));

function setup(dir) {
  const planPath = path.join(dir, 'plan.rvx');
  const ledgerPath = path.join(dir, 'ledger.json');
  const walPath = path.join(dir, 'wal.log');
  fs.writeFileSync(planPath, 'for tx in txns(*) { revoke tx; }\n');
  writeJson(ledgerPath, makeLedgerJson([
    ...makeTxn('txn:1', 'acct:a', 'acct:r', '10.00', 'SETTLED', 1),
    ...makeTxn('txn:2', 'acct:b', 'acct:r', '20.00', 'LOCKED', 0),
    ...makeTxn('txn:3', 'acct:c', 'acct:r', '30.00', 'PENDING', 2),
  ]));
  return { planPath, ledgerPath, walPath };
}

test('cli: rev run executes a plan and writes the output ledger', () => {
  const dir = makeWorkspace();
  const { planPath, ledgerPath, walPath } = setup(dir);
  const res = runCli(['run', planPath, ledgerPath, '--wal', walPath]);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.status, 'ok');
  assert.deepEqual(report.counts, { reversed: 1, compensated: 1, cancelRequested: 1, skipped: 0 });
  const out = JSON.parse(fs.readFileSync(report.out, 'utf8'));
  assert.equal(out.revocations.length, 3);
  assert.ok(fs.existsSync(walPath));
});

test('cli: crash after SAVEPOINT then rev recover reaches the reference state', () => {
  const dir = makeWorkspace();
  const { planPath, ledgerPath, walPath } = setup(dir);

  const refDir = makeWorkspace();
  const ref = setup(refDir);
  const refRun = runCli(['run', ref.planPath, ref.ledgerPath, '--wal', ref.walPath]);
  assert.equal(refRun.code, 0, refRun.stderr);
  const refOut = fs.readFileSync(JSON.parse(refRun.stdout).out, 'utf8');

  const { records } = Wal.read(ref.walPath);
  const savepoint = records.find((r) => r.op === 'SAVEPOINT');

  const crashed = runCli(['run', planPath, ledgerPath, '--wal', walPath], {
    REV_CRASH_AFTER_SEQ: String(savepoint.seq),
  });
  assert.equal(crashed.code, 3, `expected crash exit 3, got ${crashed.code}`);
  assert.match(crashed.stderr, /E_CRASH/);

  const recovered = runCli(['recover', '--wal', walPath]);
  assert.equal(recovered.code, 0, recovered.stderr);
  const report = JSON.parse(recovered.stdout);
  assert.equal(report.resumed, true);
  const recoveredOut = fs.readFileSync(report.out, 'utf8');
  assert.equal(recoveredOut, refOut, 'recovered ledger equals the no-crash reference');
});

test('cli: missing plan file exits 1 with E_IO', () => {
  const dir = makeWorkspace();
  const res = runCli(['run', path.join(dir, 'nope.rvx'), path.join(dir, 'l.json'), '--wal', path.join(dir, 'w.log')]);
  assert.equal(res.code, 1);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error.code, 'E_IO');
});

test('cli: E_STATE error carries txnId and pc on stderr', () => {
  const dir = makeWorkspace();
  const planPath = path.join(dir, 'plan.rvx');
  const ledgerPath = path.join(dir, 'ledger.json');
  fs.writeFileSync(planPath, 'revoke txn:1;\n');
  writeJson(ledgerPath, makeLedgerJson([
    ...makeTxn('txn:1', 'acct:a', 'acct:r', '10.00', 'REVERSED', 1),
  ]));
  const res = runCli(['run', planPath, ledgerPath, '--wal', path.join(dir, 'wal.log')]);
  assert.equal(res.code, 1);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error.code, 'E_STATE');
  assert.equal(err.error.txnId, 'txn:1');
  assert.equal(typeof err.error.pc, 'number');
});

test('cli: re-running with an existing WAL is refused, recover on a done WAL is idempotent', () => {
  const dir = makeWorkspace();
  const { planPath, ledgerPath, walPath } = setup(dir);
  const first = runCli(['run', planPath, ledgerPath, '--wal', walPath]);
  assert.equal(first.code, 0, first.stderr);
  const again = runCli(['run', planPath, ledgerPath, '--wal', walPath]);
  assert.equal(again.code, 1);
  assert.equal(JSON.parse(again.stderr).error.code, 'E_IO');
  const recovered = runCli(['recover', '--wal', walPath]);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).resumed, false);
});

// Smoke tests through a real child process. The sandbox swallows grandchild
// stdio pipes, so assertions use exit codes and output files only.
test('cli (subprocess): run writes the output ledger and exits 0', () => {
  const dir = makeWorkspace();
  const { planPath, ledgerPath, walPath } = setup(dir);
  const outPath = path.join(dir, 'result.json');
  const res = spawnSync(process.execPath, [BIN, 'run', planPath, ledgerPath, '--wal', walPath, '--out', outPath]);
  assert.equal(res.status, 0);
  const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(out.revocations.length, 3);
});

test('cli (subprocess): crash exits 3, recover exits 0 and reproduces the reference', () => {
  const dir = makeWorkspace();
  const { planPath, ledgerPath, walPath } = setup(dir);
  const outPath = path.join(dir, 'result.json');

  const refDir = makeWorkspace();
  const ref = setup(refDir);
  const refOutPath = path.join(refDir, 'result.json');
  const refRun = spawnSync(process.execPath, [BIN, 'run', ref.planPath, ref.ledgerPath, '--wal', ref.walPath, '--out', refOutPath]);
  assert.equal(refRun.status, 0);

  const { records } = Wal.read(ref.walPath);
  const savepoint = records.find((r) => r.op === 'SAVEPOINT');

  const crashed = spawnSync(process.execPath, [BIN, 'run', planPath, ledgerPath, '--wal', walPath, '--out', outPath], {
    env: { ...process.env, REV_CRASH_AFTER_SEQ: String(savepoint.seq) },
  });
  assert.equal(crashed.status, 3);
  assert.ok(!fs.existsSync(outPath), 'crashed run must not write the output ledger');

  const recovered = spawnSync(process.execPath, [BIN, 'recover', '--wal', walPath, '--out', outPath]);
  assert.equal(recovered.status, 0);
  assert.equal(fs.readFileSync(outPath, 'utf8'), fs.readFileSync(refOutPath, 'utf8'));
});
