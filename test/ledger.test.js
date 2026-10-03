'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { crc32 } = require('../src/crc32');
const { Ledger, EXIT_CRASH, CrashExit } = require('../src/ledger');
const { LedgerError } = require('../src/errors');
const { scanFrames } = require('../src/wal');
const { run } = require('../cli');

const EXIT_OK = 0;
const EXIT_ERR = 1;

function tmpWal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  return path.join(dir, 'ledger.wal');
}

// Drives the CLI in-process (the sandbox forbids child processes); the crash
// exit is simulated by throwing CrashExit from the injected exit function.
function runCli(args) {
  let stdout = '';
  let stderr = '';
  const io = {
    stdout: { write: (s) => (stdout += s) },
    stderr: { write: (s) => (stderr += s) },
  };
  const deps = {
    exit: (code) => {
      throw new CrashExit(code);
    },
  };
  try {
    const status = run(args, io, deps);
    return { status, stdout, stderr };
  } catch (err) {
    if (err && err.isCrashExit) return { status: err.code, stdout, stderr, crashed: true };
    throw err;
  }
}

// Independent oracle: enumerate valid COMMIT records in the raw WAL file and
// sum committed change records per merchant, without using Ledger.
function independentBalances(walPath) {
  let buf = Buffer.alloc(0);
  try {
    buf = fs.readFileSync(walPath);
  } catch {
    return {};
  }
  const { frames } = scanFrames(buf);
  const committed = new Set();
  for (const f of frames) {
    if (f.record && f.record.type === 'COMMIT') committed.add(f.record.txnId);
  }
  const balances = {};
  for (const f of frames) {
    const r = f.record;
    if (!r || (r.type !== 'PAY' && r.type !== 'CANCEL')) continue;
    if (!committed.has(r.txnId)) continue;
    balances[r.merchant] = (balances[r.merchant] || 0) + r.amount;
  }
  return balances;
}

test('crc32 matches the standard check vector', () => {
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
});

test('pay, cancel, and duplicate cancel -> E_ALREADY_CANCELLED', () => {
  const wal = tmpWal();
  const ledger = new Ledger(wal).open();

  const pay = ledger.pay({ merchant: 'm1', amount: 1000, id: 'tx_1' });
  assert.equal(pay.type, 'PAY');
  assert.equal(ledger.audit('m1').balance, 1000);

  const reversal = ledger.cancel({ txnId: 'tx_1' });
  assert.equal(reversal.type, 'CANCEL');
  assert.equal(reversal.amount, -1000); // reversing entry
  assert.equal(ledger.audit('m1').balance, 0);

  assert.throws(() => ledger.cancel({ txnId: 'tx_1' }), (err) => {
    assert.ok(err instanceof LedgerError);
    assert.equal(err.code, 'E_ALREADY_CANCELLED');
    return true;
  });

  // State survives a restart (rebuilt from WAL).
  const reopened = new Ledger(wal).open();
  assert.equal(reopened.audit('m1').balance, 0);
  assert.equal(reopened.audit('m1').entries.length, 2);
  assert.throws(
    () => reopened.cancel({ txnId: 'tx_1' }),
    (err) => err.code === 'E_ALREADY_CANCELLED'
  );
});

test('CLI: pay/cancel/double-cancel exit codes and JSON errors', () => {
  const wal = tmpWal();

  let r = runCli(['--wal', wal, 'pay', '--merchant', 'm1', '--amount', '500', '--id', 'tx_a']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);

  r = runCli(['--wal', wal, 'cancel', '--txn', 'tx_a']);
  assert.equal(r.status, 0, r.stderr);

  r = runCli(['--wal', wal, 'cancel', '--txn', 'tx_a']);
  assert.notEqual(r.status, 0);
  const errBody = JSON.parse(r.stderr);
  assert.equal(errBody.error.code, 'E_ALREADY_CANCELLED');

  r = runCli(['--wal', wal, 'cancel', '--txn', 'tx_missing']);
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stderr).error.code, 'E_TXN_NOT_FOUND');
});

test('crash P1 (after change record, before COMMIT): recovery discards txn', () => {
  const wal = tmpWal();

  const r = runCli(['--wal', wal, 'crash', '--point', 'P1', '--merchant', 'm1', '--amount', '700', '--id', 'tx_p1']);
  assert.equal(r.status, EXIT_CRASH, `expected crash exit, got ${r.status}: ${r.stderr}`);

  const rec = runCli(['--wal', wal, 'recover']);
  assert.equal(rec.status, 0, rec.stderr);

  const audit = runCli(['--wal', wal, 'audit', '--merchant', 'm1']);
  assert.equal(audit.status, 0, audit.stderr);
  const body = JSON.parse(audit.stdout);
  assert.equal(body.balance, 0); // balance unchanged
  assert.equal(body.entries.length, 0); // no transaction visible
});

test('crash P2 (after COMMIT, before reply): recovery redoes txn', () => {
  const wal = tmpWal();

  const r = runCli(['--wal', wal, 'crash', '--point', 'P2', '--merchant', 'm1', '--amount', '700', '--id', 'tx_p2']);
  assert.equal(r.status, EXIT_CRASH, `expected crash exit, got ${r.status}: ${r.stderr}`);

  const rec = runCli(['--wal', wal, 'recover']);
  assert.equal(rec.status, 0, rec.stderr);

  const audit = runCli(['--wal', wal, 'audit', '--merchant', 'm1']);
  assert.equal(audit.status, 0, audit.stderr);
  const body = JSON.parse(audit.stdout);
  assert.equal(body.balance, 700); // committed txn took effect
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].txnId, 'tx_p2');
});

test('corrupted tail (bad CRC / truncated frame) is discarded; matches independent sum', () => {
  for (const mode of ['corrupt-crc', 'truncate']) {
    const wal = tmpWal();
    const ledger = new Ledger(wal).open();
    ledger.pay({ merchant: 'm1', amount: 100, id: 'tx_1' });
    ledger.pay({ merchant: 'm1', amount: 250, id: 'tx_2' });
    ledger.pay({ merchant: 'm2', amount: 40, id: 'tx_3' });
    ledger.cancel({ txnId: 'tx_1' });
    ledger.pay({ merchant: 'm1', amount: 5, id: 'tx_4' });

    // Corrupt the tail of the WAL.
    const before = fs.readFileSync(wal);
    const { frames, validEnd } = scanFrames(before);
    assert.equal(validEnd, before.length);
    const last = frames[frames.length - 1];
    if (mode === 'corrupt-crc') {
      const corrupted = Buffer.from(before);
      corrupted[last.offset + 8] ^= 0xff; // break the CRC of the last frame
      fs.writeFileSync(wal, corrupted);
    } else {
      const keep = last.offset + Math.floor((last.end - last.offset) / 2);
      fs.truncateSync(wal, keep); // cut the last frame in half
    }

    // Independent oracle runs on the corrupted file.
    const expected = independentBalances(wal);

    const reopened = new Ledger(wal).open();
    assert.ok(reopened.discardedBytes > 0, `${mode}: expected discarded bytes`);
    assert.deepEqual(Object.fromEntries(reopened.balances), expected, mode);

    // The corrupt tail is truncated, so new appends land on a clean WAL.
    reopened.pay({ merchant: 'm2', amount: 60, id: `tx_5_${mode}` });
    const again = new Ledger(wal).open();
    assert.equal(again.audit('m2').balance, (expected.m2 || 0) + 60, mode);
  }
});

test('cancel of unknown txn and invalid amounts are rejected', () => {
  const wal = tmpWal();
  const ledger = new Ledger(wal).open();
  assert.throws(() => ledger.cancel({ txnId: 'nope' }), (e) => e.code === 'E_TXN_NOT_FOUND');
  assert.throws(() => ledger.pay({ merchant: 'm', amount: -5 }), (e) => e.code === 'E_INVALID_AMOUNT');
  assert.throws(() => ledger.pay({ merchant: 'm', amount: 1.5 }), (e) => e.code === 'E_INVALID_AMOUNT');
  assert.throws(() => ledger.pay({ merchant: '', amount: 5 }), (e) => e.code === 'E_INVALID_ARGS');
});
