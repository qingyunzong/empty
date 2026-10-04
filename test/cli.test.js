import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordRecoveryHash } from '../src/recovery-report.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'cli.js');

// Child-process stdio is redirected through files because this environment
// does not permit piping stdout/stderr from spawned node processes.
let ioCounter = 0;
function runCli(args) {
  const tag = `${process.pid}-${ioCounter++}`;
  const outFile = path.join(os.tmpdir(), `cli-${tag}.out`);
  const errFile = path.join(os.tmpdir(), `cli-${tag}.err`);
  return new Promise((resolve, reject) => {
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', outFd, errFd],
    });
    child.on('error', reject);
    child.on('close', (code) => {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      const stdout = fs.readFileSync(outFile, 'utf8');
      const stderr = fs.readFileSync(errFile, 'utf8');
      fs.rmSync(outFile, { force: true });
      fs.rmSync(errFile, { force: true });
      resolve({ status: code, stdout, stderr });
    });
  });
}

function tmpLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = path.join(dir, 'ledger.json');
  const spec = {
    ops: [
      { op: 'submit', entryId: 'e1', payer: 'alice', payee: 'bob', amount: 100 },
      { op: 'submit', entryId: 'e2', payer: 'bob', payee: 'carol', amount: 40 },
      { op: 'submit', entryId: 'e3', payer: 'carol', payee: 'alice', amount: 25 },
      { op: 'submit', entryId: 'e1', payer: 'alice', payee: 'bob', amount: 100 }, // duplicate
      { op: 'settle' },
    ],
  };
  fs.writeFileSync(ledgerPath, JSON.stringify(spec));
  return { dir, ledgerPath };
}

async function recover(ledgerPath) {
  const res = await runCli(['recover', ledgerPath]);
  assert.equal(res.status, 0, `recover failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function settledIds(recovered) {
  return Object.values(recovered.state.entries)
    .filter((e) => e.status === 'settled')
    .map((e) => e.entryId)
    .sort();
}

test('CLI: clean run settles all pending entries; duplicate submit is idempotent', async (t) => {
  const { ledgerPath } = tmpLedger(t);
  const res = await runCli(['run', ledgerPath]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /submit e1: duplicate/);
  const rec = await recover(ledgerPath);
  assert.deepEqual(settledIds(rec), ['e1', 'e2', 'e3']);
  assert.equal(Object.keys(rec.state.entries).length, 3, 'duplicate submit must not create a second entry');
  recordRecoveryHash('clean-run', rec.recoveryHash);
});

test('CLI: crash at settle:beforeRename leaves no entry settled after recovery', async (t) => {
  const { ledgerPath } = tmpLedger(t);
  const res = await runCli(['run', ledgerPath, '--crash', 'settle:beforeRename']);
  assert.equal(res.status, 75, `expected crash exit 75, got ${res.status}: ${res.stderr}`);
  assert.match(res.stderr, /CRASH simulated at settle:beforeRename/);
  const rec = await recover(ledgerPath);
  assert.deepEqual(settledIds(rec), [], 'beforeRename crash must not settle anything');
  assert.equal(rec.state.settlements.length, 0);
  // submitted entries are confirmed and must survive the crash
  assert.equal(Object.keys(rec.state.entries).length, 3);
  recordRecoveryHash('crash=settle:beforeRename', rec.recoveryHash);
});

test('CLI: crash at settle:afterRename recovers with all entries settled', async (t) => {
  const { ledgerPath } = tmpLedger(t);
  const res = await runCli(['run', ledgerPath, '--crash', 'settle:afterRename']);
  assert.equal(res.status, 75, `expected crash exit 75, got ${res.status}: ${res.stderr}`);
  const rec = await recover(ledgerPath);
  assert.deepEqual(settledIds(rec), ['e1', 'e2', 'e3'], 'afterRename crash must recover fully settled');
  assert.equal(rec.state.settlements.length, 1);
  recordRecoveryHash('crash=settle:afterRename', rec.recoveryHash);
});

test('CLI: cancel of a settled entry is rejected with ENTRY_NOT_PENDING and changes nothing', async (t) => {
  const { ledgerPath } = tmpLedger(t);
  assert.equal((await runCli(['run', ledgerPath])).status, 0);
  const before = await recover(ledgerPath);
  const logBefore = fs.readFileSync(path.join(`${ledgerPath}.state`, 'ledger.log'), 'utf8');

  const spec = { ops: [{ op: 'cancel', entryId: 'e1' }] };
  fs.writeFileSync(ledgerPath, JSON.stringify(spec));
  const res = await runCli(['run', ledgerPath]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /ERROR ENTRY_NOT_PENDING/);

  const after = await recover(ledgerPath);
  assert.equal(after.recoveryHash, before.recoveryHash, 'rejected cancel must not change recovered state');
  const logAfter = fs.readFileSync(path.join(`${ledgerPath}.state`, 'ledger.log'), 'utf8');
  assert.equal(logAfter, logBefore, 'rejected cancel must not append to the log');
});

test('CLI: corrupt durableWatermark -> snapshot ignored, full log replay recovers state', async (t) => {
  const { ledgerPath } = tmpLedger(t);
  assert.equal((await runCli(['run', ledgerPath])).status, 0);
  const good = await recover(ledgerPath);
  assert.equal(good.source, 'snapshot+log');

  const wmPath = path.join(`${ledgerPath}.state`, 'ledger.wm');
  fs.writeFileSync(wmPath, '{"seq": not-json!!!');

  const rec = await recover(ledgerPath);
  assert.equal(rec.source, 'log-only:watermark-missing-or-corrupt');
  assert.equal(rec.recoveryHash, good.recoveryHash, 'log replay must reproduce the snapshot state');
  assert.deepEqual(settledIds(rec), ['e1', 'e2', 'e3']);
  recordRecoveryHash('corrupt-watermark', rec.recoveryHash);
});

test('CLI: corrupt snapshot -> recovery falls back to the change log', async (t) => {
  const { ledgerPath } = tmpLedger(t);
  assert.equal((await runCli(['run', ledgerPath])).status, 0);
  const good = await recover(ledgerPath);

  const snapPath = path.join(`${ledgerPath}.state`, 'ledger.snap');
  fs.writeFileSync(snapPath, 'garbage-bytes-not-a-snapshot');

  const rec = await recover(ledgerPath);
  assert.equal(rec.source, 'log-only:snapshot-corrupt');
  assert.equal(rec.recoveryHash, good.recoveryHash, 'log replay must reproduce the snapshot state');
  assert.deepEqual(settledIds(rec), ['e1', 'e2', 'e3']);
  recordRecoveryHash('corrupt-snapshot', rec.recoveryHash);
});

test('CLI: missing snapshot with valid watermark -> log replay still recovers', async (t) => {
  const { ledgerPath } = tmpLedger(t);
  assert.equal((await runCli(['run', ledgerPath])).status, 0);
  const good = await recover(ledgerPath);
  fs.rmSync(path.join(`${ledgerPath}.state`, 'ledger.snap'));
  const rec = await recover(ledgerPath);
  assert.equal(rec.source, 'log-only:snapshot-corrupt');
  assert.equal(rec.recoveryHash, good.recoveryHash);
});
