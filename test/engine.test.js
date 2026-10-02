'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine');
const chain = require('../src/chain');
const store = require('../src/store');
const { tmpdir } = require('../testlib/helpers');

test('enqueue is idempotent for the same payment', () => {
  const dir = tmpdir();
  engine.createAccount(dir, 'A', 100);
  assert.equal(engine.enqueue(dir, 'A', 'p1', 10).enqueued, true);
  assert.equal(engine.enqueue(dir, 'A', 'p1', 10).enqueued, false);
  assert.equal(Object.keys(store.loadState(dir).payments).length, 1);
  assert.throws(() => engine.enqueue(dir, 'A', 'p1', 20), engine.UsageError);
  assert.throws(() => engine.enqueue(dir, 'B', 'p2', 5), engine.FailError);
});

test('freeze only affects available budget and cancel releases it immediately', () => {
  const dir = tmpdir();
  engine.createAccount(dir, 'A', 100);
  engine.enqueue(dir, 'A', 'p1', 30);
  engine.enqueue(dir, 'A', 'p2', 40);

  engine.freeze(dir, 'p1');
  let state = store.loadState(dir);
  assert.equal(state.accounts.A.frozen, 30);
  assert.equal(state.accounts.A.used, 0);
  assert.equal(engine.availableOf(state.accounts.A), 70);

  // Not enough available budget for p2 (40) after also freezing a third payment.
  engine.enqueue(dir, 'A', 'p3', 50);
  engine.freeze(dir, 'p3');
  assert.equal(engine.availableOf(store.loadState(dir).accounts.A), 20);
  assert.throws(() => engine.freeze(dir, 'p2'), /insufficient available budget/);

  // Cancelling a frozen payment releases its freeze at once.
  engine.cancel(dir, 'p3');
  state = store.loadState(dir);
  assert.equal(state.accounts.A.frozen, 30);
  assert.equal(engine.availableOf(state.accounts.A), 70);
  assert.equal(state.payments.p3.status, 'cancelled');

  // Cancelling a queued payment touches nothing.
  engine.cancel(dir, 'p2');
  state = store.loadState(dir);
  assert.equal(state.accounts.A.frozen, 30);
  assert.equal(state.payments.p2.status, 'cancelled');

  // Freeze is idempotent; cancel of a cancelled payment is a no-op.
  assert.equal(engine.freeze(dir, 'p1').changed, false);
  assert.equal(engine.cancel(dir, 'p2').changed, false);
});

test('settled payments cannot be cancelled; refund restores budget via reverse block', () => {
  const dir = tmpdir();
  engine.createAccount(dir, 'A', 100);
  engine.enqueue(dir, 'A', 'p1', 60);

  const { batch: settleBatch } = engine.settle(dir);
  assert.equal(settleBatch.type, 'settle');
  assert.deepEqual(settleBatch.selected.map((s) => s.id), ['p1']);
  let state = store.loadState(dir);
  assert.equal(state.accounts.A.used, 60);
  assert.equal(state.payments.p1.status, 'settled');

  assert.throws(() => engine.cancel(dir, 'p1'), /cannot be cancelled/);
  assert.throws(() => engine.refund(dir, 'p2'), engine.FailError);

  const { batch: refundBatch } = engine.refund(dir, 'p1');
  assert.equal(refundBatch.type, 'refund');
  assert.equal(refundBatch.refHash, settleBatch.hash, 'reverse block references the original settle hash');
  assert.equal(refundBatch.prevHash, settleBatch.hash);

  state = store.loadState(dir);
  assert.equal(state.accounts.A.used, 0, 'budget restored after refund');
  assert.equal(state.payments.p1.status, 'refunded');
  assert.throws(() => engine.refund(dir, 'p1'), /cannot refund/);

  const verification = chain.verifyChain(dir);
  assert.equal(verification.ok, true);
  assert.equal(verification.batches.length, 2);
  assert.equal(chain.readBatch(dir, 2).body.refHash, settleBatch.hash);
});

test('settle picks the maximum set with lexicographic tie-break and records rejects', () => {
  const dir = tmpdir();
  engine.createAccount(dir, 'A', 10);
  engine.enqueue(dir, 'A', 'p1', 6);
  engine.enqueue(dir, 'A', 'p2', 6);
  engine.enqueue(dir, 'A', 'p3', 4);

  const { batch } = engine.settle(dir);
  // Feasible size-2 sets: {p1,p3} and {p2,p3}; lexicographic minimum wins.
  assert.deepEqual(batch.selected.map((s) => s.id), ['p1', 'p3']);
  assert.deepEqual(batch.rejected, ['p2']);

  const state = store.loadState(dir);
  assert.equal(state.accounts.A.used, 10);
  assert.equal(state.payments.p2.status, 'queued', 'rejected payment stays queued');

  // Rejected payment becomes settleable after a refund frees budget.
  engine.refund(dir, 'p1');
  const { batch: second } = engine.settle(dir);
  assert.deepEqual(second.selected.map((s) => s.id), ['p2']);
});

test('frozen payments settle without consuming available budget again', () => {
  const dir = tmpdir();
  engine.createAccount(dir, 'A', 100);
  engine.enqueue(dir, 'A', 'p1', 70);
  engine.enqueue(dir, 'A', 'p2', 40);
  engine.freeze(dir, 'p1'); // reserves 70; available is now 30
  const { batch } = engine.settle(dir);
  // p1 is already covered by its freeze; p2 (40) does not fit in 30.
  assert.deepEqual(batch.selected.map((s) => s.id), ['p1']);
  assert.deepEqual(batch.rejected, ['p2']);
  const state = store.loadState(dir);
  assert.equal(state.accounts.A.frozen, 0);
  assert.equal(state.accounts.A.used, 70);
});

test('settle with no pending payments writes no batch', () => {
  const dir = tmpdir();
  engine.createAccount(dir, 'A', 100);
  const { batch } = engine.settle(dir);
  assert.equal(batch, null);
  assert.equal(store.loadState(dir).lastBatch, 0);
  assert.equal(chain.verifyChain(dir).batches.length, 0);
});
