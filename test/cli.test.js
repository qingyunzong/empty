import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';

function runCli(command, logDir, { expectError = false } = {}) {
  fs.mkdirSync(logDir, { recursive: true });
  const cmdFile = path.join(logDir, `cmd-${process.hrtime.bigint()}.json`);
  fs.writeFileSync(cmdFile, typeof command === 'string' ? command : JSON.stringify(command));
  let stdout = '';
  let exitCode = null;
  run([cmdFile, logDir], {
    stdout: (s) => { stdout += s; },
    exit: (c) => { exitCode = c; },
  });
  if (expectError) {
    assert.equal(exitCode, 1, `expected exit 1, got ${exitCode}: ${stdout}`);
  } else {
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}: ${stdout}`);
  }
  return JSON.parse(stdout);
}

function withLogDir(fn) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saga-'));
  try {
    fn(logDir);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}

test('cli: execute then cancel returns certificate and persists state', () => {
  withLogDir((logDir) => {
    runCli({ op: 'deposit', accountId: 'a', amount: 300 }, logDir);
    const trade = runCli(
      { op: 'execute', tradeId: 't1', accountId: 'a', amount: 100, fee: 5 },
      logDir,
    );
    assert.equal(trade.status, 'EXECUTED');
    assert.equal(trade.fee, 5);

    const result = runCli({ op: 'cancel', tradeId: 't1' }, logDir);
    assert.equal(result.status, 'CANCELLED');
    assert.deepEqual(result.certificate.compensated, [
      'UNDO_MATCH',
      'REFUND_FEE',
      'RELEASE_RESERVE',
    ]);
    assert.equal(result.certificate.account.available, 300);

    const account = runCli({ op: 'account', accountId: 'a' }, logDir);
    assert.equal(account.available, 300);
    assert.equal(account.reserved, 0);
    // State persisted: journal and snapshot exist.
    assert.ok(fs.existsSync(path.join(logDir, 'state.json')));
    assert.ok(fs.existsSync(path.join(logDir, 'journal.log')));
  });
});

test('cli: irreversible trade exits 1 with IRREVERSIBLE_CONFLICT and balances unchanged', () => {
  withLogDir((logDir) => {
    runCli({ op: 'deposit', accountId: 'a', amount: 300 }, logDir);
    runCli(
      { op: 'execute', tradeId: 't1', accountId: 'a', amount: 100, fee: 5, irreversible: true },
      logDir,
    );
    const err = runCli({ op: 'cancel', tradeId: 't1' }, logDir, { expectError: true });
    assert.equal(err.error.code, 'IRREVERSIBLE_CONFLICT');

    const account = runCli({ op: 'account', accountId: 'a' }, logDir);
    assert.equal(account.available, 195);
    assert.equal(account.reserved, 100);
  });
});

test('cli: branch failure then recovery across invocations', () => {
  withLogDir((logDir) => {
    runCli({ op: 'deposit', accountId: 'a', amount: 300 }, logDir);
    runCli({ op: 'execute', tradeId: 't1', accountId: 'a', amount: 100, fee: 5 }, logDir);

    const failed = runCli({ op: 'cancel', tradeId: 't1', fail: ['REFUND_FEE'] }, logDir);
    assert.equal(failed.status, 'CANCELLING');
    assert.equal(failed.failed.branch, 'REFUND_FEE');
    assert.deepEqual(failed.acked, ['UNDO_MATCH']);

    const recovered = runCli({ op: 'cancel', tradeId: 't1' }, logDir);
    assert.equal(recovered.status, 'CANCELLED');
    assert.deepEqual(recovered.certificate.compensated, [
      'UNDO_MATCH',
      'REFUND_FEE',
      'RELEASE_RESERVE',
    ]);
    assert.equal(recovered.certificate.account.available, 300);
  });
});

test('cli: unknown trade and invalid command exit 1 with error code', () => {
  withLogDir((logDir) => {
    const err = runCli({ op: 'cancel', tradeId: 'nope' }, logDir, { expectError: true });
    assert.equal(err.error.code, 'UNKNOWN_TRADE');

    const bad = runCli({ op: 'explode' }, logDir, { expectError: true });
    assert.equal(bad.error.code, 'INVALID_COMMAND');
  });
});

test('cli: malformed JSON exits 1 with INVALID_COMMAND', () => {
  withLogDir((logDir) => {
    const err = runCli('{not json', logDir, { expectError: true });
    assert.equal(err.error.code, 'INVALID_COMMAND');
  });
});
