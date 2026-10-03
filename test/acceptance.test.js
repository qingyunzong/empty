import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PaymentService, OPENING_BALANCE } from '../src/payments.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'paydb-accept-'));
}

// Acceptance 1: pay, then duplicate pay with the same requestId -> balance is
// charged once and both calls return the same transaction id.
test('duplicate pay returns first result and charges once', () => {
  const dir = tempDir();
  let svc = PaymentService.open(dir);
  const first = svc.pay({ requestId: 'r1', amount: 100 });
  assert.equal(first.status, 'ok');
  assert.equal(first.txnId, 'T000001');
  svc.close();

  // Reopen (new process boundary) and repeat the same requestId.
  svc = PaymentService.open(dir);
  const dup = svc.pay({ requestId: 'r1', amount: 100 });
  assert.deepEqual(dup, first);
  const dupOtherAmount = svc.pay({ requestId: 'r1', amount: 999 });
  assert.deepEqual(dupOtherAmount, first);
  assert.equal(svc.getBalance(), OPENING_BALANCE - 100);
  assert.equal(svc.listTransactions().length, 1);
  svc.close();
});

// Acceptance 2a: P1 crash (after business change, before COMMIT) -> the
// transaction is rolled back on restart; retry with the same requestId
// produces a successful NEW transaction and charges exactly once.
test('P1 crash rolls back; retry creates a new successful transaction', () => {
  const dir = tempDir();
  let svc = PaymentService.open(dir);
  assert.throws(() => svc.pay({ requestId: 'rP1', amount: 100 }, { crashAt: 'P1' }), { code: 'E_CRASH' });
  svc.close();

  svc = PaymentService.open(dir);
  // Rolled back: no charge, no request result, no transaction visible.
  assert.equal(svc.getBalance(), OPENING_BALANCE);
  assert.throws(() => svc.getRequest('rP1'), { code: 'E_NOT_FOUND' });
  assert.equal(svc.listTransactions().length, 0);

  const retried = svc.retry({ requestId: 'rP1' });
  assert.equal(retried.status, 'ok');
  assert.equal(retried.txnId, 'T000002'); // new transaction, not the aborted T000001
  assert.equal(svc.getBalance(), OPENING_BALANCE - 100); // charged exactly once
  svc.close();

  svc = PaymentService.open(dir);
  assert.equal(svc.getBalance(), OPENING_BALANCE - 100);
  assert.deepEqual(svc.retry({ requestId: 'rP1' }), retried); // stable after restart
  svc.close();
});

// Acceptance 2b: P2 crash (after COMMIT, before response) -> the committed
// transaction survives; retry with the same requestId returns the ORIGINAL
// transaction and never charges twice.
test('P2 crash keeps commit; retry returns the original transaction', () => {
  const dir = tempDir();
  let svc = PaymentService.open(dir);
  assert.throws(() => svc.pay({ requestId: 'rP2', amount: 100 }, { crashAt: 'P2' }), { code: 'E_CRASH' });
  svc.close();

  svc = PaymentService.open(dir);
  const committed = svc.getRequest('rP2'); // response was lost, effect was not
  assert.equal(committed.status, 'ok');
  assert.equal(committed.txnId, 'T000001');
  const retried = svc.retry({ requestId: 'rP2' });
  assert.deepEqual(retried, committed); // original transaction returned
  assert.equal(svc.getBalance(), OPENING_BALANCE - 100); // not charged twice
  assert.equal(svc.listTransactions().length, 1);
  svc.close();
});

// Acceptance 2c: same crash semantics for cancel.
test('cancel survives P1/P2 crashes with identical retry semantics', () => {
  const dir = tempDir();
  let svc = PaymentService.open(dir);
  svc.pay({ requestId: 'r1', amount: 100 });
  assert.throws(() => svc.cancel({ requestId: 'c1', txnId: 'T000001' }, { crashAt: 'P1' }), { code: 'E_CRASH' });
  svc.close();

  svc = PaymentService.open(dir);
  assert.equal(svc.getBalance(), OPENING_BALANCE - 100); // cancel rolled back
  const retried = svc.retry({ requestId: 'c1' });
  assert.equal(retried.status, 'ok');
  assert.equal(retried.targetTxnId, 'T000001');
  assert.equal(svc.getBalance(), OPENING_BALANCE); // refunded exactly once
  svc.close();

  svc = PaymentService.open(dir);
  const pay2 = svc.pay({ requestId: 'r2', amount: 50 });
  assert.throws(() => svc.cancel({ requestId: 'c2', txnId: pay2.txnId }, { crashAt: 'P2' }), { code: 'E_CRASH' });
  svc.close();

  svc = PaymentService.open(dir);
  const committed = svc.getRequest('c2');
  assert.deepEqual(svc.retry({ requestId: 'c2' }), committed);
  assert.equal(svc.getBalance(), OPENING_BALANCE); // both r1 and r2 were refunded exactly once
  svc.close();
});

// Acceptance 3: duplicate cancel returns the first cancel result; cancelling
// an unknown transaction returns E_NOT_FOUND.
test('duplicate cancel returns first result; unknown transaction is E_NOT_FOUND', () => {
  const dir = tempDir();
  let svc = PaymentService.open(dir);
  svc.pay({ requestId: 'r1', amount: 100 });
  const first = svc.cancel({ requestId: 'c1', txnId: 'T000001' });
  assert.equal(first.status, 'ok');
  svc.close();

  svc = PaymentService.open(dir);
  const dup = svc.cancel({ requestId: 'c1', txnId: 'T000001' });
  assert.deepEqual(dup, first); // same cancel transaction id, no double refund
  assert.equal(svc.getBalance(), OPENING_BALANCE);
  assert.equal(svc.listTransactions().length, 2);

  assert.throws(() => svc.cancel({ requestId: 'c2', txnId: 'T999999' }), { code: 'E_NOT_FOUND' });
  // A different requestId against the already-cancelled txn is E_INVALID_STATE.
  assert.throws(() => svc.cancel({ requestId: 'c3', txnId: 'T000001' }), { code: 'E_INVALID_STATE' });
  svc.close();
});

// Retry of a requestId that was never seen is E_NOT_FOUND.
test('retry of unknown requestId is E_NOT_FOUND', () => {
  const dir = tempDir();
  const svc = PaymentService.open(dir);
  assert.throws(() => svc.retry({ requestId: 'nope' }), { code: 'E_NOT_FOUND' });
  svc.close();
});
