import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function run(dir, args) {
  const proc = spawnSync(process.execPath, [CLI, '--db', dir, ...args], { encoding: 'utf8' });
  return {
    status: proc.status,
    json: proc.stdout.trim() ? JSON.parse(proc.stdout.trim()) : null,
    stderr: proc.stderr,
  };
}

test('cli: pay/cancel/retry/get flow incl. P2 crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paycli-'));
  try {
    const paid = run(dir, ['pay', '--request-id', 'r1', '--account', 'alice', '--amount', '120']);
    assert.equal(paid.status, 0);
    assert.equal(paid.json.ok, true);
    assert.equal(paid.json.txId, 'tx-1');

    const dup = run(dir, ['pay', '--request-id', 'r1', '--account', 'alice', '--amount', '120']);
    assert.equal(dup.status, 0);
    assert.deepEqual(dup.json, paid.json);

    const balance = run(dir, ['get', '--account', 'alice']);
    assert.equal(balance.json.balance, 880);

    // crash after COMMIT, before response
    const crashed = run(dir, ['pay', '--request-id', 'r2', '--account', 'alice', '--amount', '30', '--crash-at', 'P2']);
    assert.equal(crashed.status, 2);
    assert.equal(crashed.json, null);

    const retried = run(dir, ['retry', '--request-id', 'r2']);
    assert.equal(retried.status, 0);
    assert.equal(retried.json.txId, 'tx-2');
    assert.equal(retried.json.balance, 850);

    const cancelled = run(dir, ['cancel', '--request-id', 'c1', '--tx', retried.json.txId]);
    assert.equal(cancelled.status, 0);
    assert.equal(cancelled.json.status, 'canceled');

    const cancelledAgain = run(dir, ['cancel', '--request-id', 'c1', '--tx', retried.json.txId]);
    assert.deepEqual(cancelledAgain.json, cancelled.json);

    const missing = run(dir, ['cancel', '--request-id', 'c2', '--tx', 'tx-zzz']);
    assert.equal(missing.status, 1);
    assert.equal(missing.json.error, 'E_NOT_FOUND');

    const got = run(dir, ['get', '--tx', 'tx-2']);
    assert.equal(got.json.txn.status, 'canceled');

    const finalBalance = run(dir, ['get', '--account', 'alice']);
    assert.equal(finalBalance.json.balance, 880);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: P1 crash leaves no trace; retry creates a new transaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paycli-'));
  try {
    const crashed = run(dir, ['pay', '--request-id', 'r9', '--account', 'bob', '--amount', '10', '--crash-at', 'P1']);
    assert.equal(crashed.status, 2);

    const missing = run(dir, ['get', '--tx', 'tx-1']);
    assert.equal(missing.json.error, 'E_NOT_FOUND');

    const retried = run(dir, ['retry', '--request-id', 'r9']);
    assert.equal(retried.status, 0);
    assert.equal(retried.json.txId, 'tx-2');
    assert.equal(retried.json.balance, 990);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
