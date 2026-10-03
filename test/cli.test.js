import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../cli.js';

// Each invocation goes through runCli with a fresh PaymentService (same
// open/close lifecycle as a separate OS process).
function run(dir, args) {
  const lines = { stdout: [], stderr: [] };
  const code = runCli([...args, '--data-dir', dir], {
    stdout: (line) => lines.stdout.push(line),
    stderr: (line) => lines.stderr.push(line),
  });
  const jsonLine = [...lines.stdout, ...lines.stderr].find((l) => l.startsWith('{'));
  return { code, out: jsonLine ? JSON.parse(jsonLine) : null };
}

test('CLI: pay/cancel/retry/get end to end with crash points', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paydb-cli-'));

  // pay + duplicate pay: charged once, same transaction id
  const pay1 = run(dir, ['pay', '--request-id', 'r1', '--amount', '100']);
  assert.equal(pay1.code, 0);
  assert.deepEqual(pay1.out.result, {
    status: 'ok', type: 'pay', requestId: 'r1', txnId: 'T000001', account: 'main', amount: 100,
  });
  const dup = run(dir, ['pay', '--request-id', 'r1', '--amount', '100']);
  assert.deepEqual(dup.out.result, pay1.out.result);
  assert.equal(run(dir, ['get', '--balance']).out.result.balance, 900);

  // P1 crash then retry -> new transaction, charged once
  const crash = run(dir, ['pay', '--request-id', 'r2', '--amount', '50', '--crash-at', 'P1']);
  assert.equal(crash.code, 2);
  assert.deepEqual(crash.out, { ok: false, crashed: true, point: 'P1' });
  assert.equal(run(dir, ['get', '--balance']).out.result.balance, 900);
  const retried = run(dir, ['retry', '--request-id', 'r2']);
  assert.equal(retried.out.result.status, 'ok');
  assert.equal(retried.out.result.txnId, 'T000003');
  assert.equal(run(dir, ['get', '--balance']).out.result.balance, 850);

  // P2 crash then retry -> original transaction, not charged twice
  const crash2 = run(dir, ['pay', '--request-id', 'r3', '--amount', '25', '--crash-at', 'P2']);
  assert.equal(crash2.code, 2);
  assert.deepEqual(crash2.out, { ok: false, crashed: true, point: 'P2' });
  const retried2 = run(dir, ['retry', '--request-id', 'r3']);
  assert.equal(retried2.out.result.txnId, 'T000004');
  assert.equal(run(dir, ['get', '--balance']).out.result.balance, 825);

  // cancel + duplicate cancel: first result, refunded once
  const cancel = run(dir, ['cancel', '--request-id', 'c1', '--txn-id', 'T000001']);
  assert.equal(cancel.out.result.type, 'cancel');
  assert.equal(cancel.out.result.targetTxnId, 'T000001');
  const cancelDup = run(dir, ['cancel', '--request-id', 'c1', '--txn-id', 'T000001']);
  assert.deepEqual(cancelDup.out.result, cancel.out.result);
  assert.equal(run(dir, ['get', '--balance']).out.result.balance, 925);

  // cancel unknown transaction -> E_NOT_FOUND
  const notFound = run(dir, ['cancel', '--request-id', 'c9', '--txn-id', 'T999999']);
  assert.equal(notFound.code, 1);
  assert.equal(notFound.out.ok, false);
  assert.equal(notFound.out.error.code, 'E_NOT_FOUND');

  // get by txn-id and request-id
  assert.equal(run(dir, ['get', '--txn-id', 'T000001']).out.result.status, 'CANCELLED');
  assert.deepEqual(run(dir, ['get', '--request-id', 'r1']).out.result, pay1.out.result);
  assert.equal(run(dir, ['get', '--txn-id', 'T000042']).out.error.code, 'E_NOT_FOUND');

  // usage errors
  assert.equal(run(dir, ['pay', '--request-id', 'r9']).code, 2);
  assert.equal(run(dir, ['bogus']).code, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});
