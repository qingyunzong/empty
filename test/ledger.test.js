'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger, BizError, GENESIS_HASH } = require('../lib/ledger');
const { tmpLedgerDir } = require('./helpers');

test('enqueue freezes budget; repeat enqueue is idempotent', () => {
  const ledger = new Ledger(tmpLedgerDir());
  ledger.freeze('A', 100);
  const first = ledger.enqueue('p1', 'A', 40);
  assert.equal(first.idempotent, false);
  assert.deepEqual(
    { budget: 100, frozen: 40, available: 60 },
    (({ budget, frozen, available }) => ({ budget, frozen, available }))(first.account)
  );
  const second = ledger.enqueue('p1', 'A', 40);
  assert.equal(second.idempotent, true);
  assert.equal(second.status, 'queued');
  // Frozen only once.
  assert.equal(ledger.snapshot().accounts.A.frozen, 40);
  assert.equal(ledger.snapshot().accounts.A.available, 60);
});

test('enqueue beyond available budget fails', () => {
  const ledger = new Ledger(tmpLedgerDir());
  ledger.freeze('A', 50);
  assert.throws(() => ledger.enqueue('p1', 'A', 60), BizError);
  ledger.enqueue('p1', 'A', 40);
  assert.throws(() => ledger.enqueue('p2', 'A', 20), /insufficient available budget/);
});

test('enqueue on unknown account fails', () => {
  const ledger = new Ledger(tmpLedgerDir());
  assert.throws(() => ledger.enqueue('p1', 'nope', 10), /unknown account/);
});

test('freeze only affects available budget, not queued payments', () => {
  const ledger = new Ledger(tmpLedgerDir());
  ledger.freeze('A', 100);
  ledger.enqueue('p1', 'A', 70);
  const view = ledger.freeze('A', 50); // lower budget below frozen
  assert.equal(view.budget, 50);
  assert.equal(view.frozen, 70);
  assert.equal(view.available, -20);
  // Payment is still queued and settleable under the new budget rule.
  assert.deepEqual(ledger.snapshot().queue, ['p1']);
});

test('cancel releases the freeze immediately; repeat cancel is idempotent', () => {
  const ledger = new Ledger(tmpLedgerDir());
  ledger.freeze('A', 100);
  ledger.enqueue('p1', 'A', 40);
  ledger.enqueue('p2', 'A', 30);
  const r = ledger.cancel('p1');
  assert.equal(r.status, 'cancelled');
  assert.equal(r.account.frozen, 30);
  assert.equal(r.account.available, 70);
  assert.deepEqual(ledger.snapshot().queue, ['p2']);
  const again = ledger.cancel('p1');
  assert.equal(again.idempotent, true);
  assert.equal(ledger.snapshot().accounts.A.frozen, 30);
  assert.throws(() => ledger.cancel('ghost'), /unknown payment/);
});

test('settle commits a block, spends budget, keeps rejected queued', () => {
  const ledger = new Ledger(tmpLedgerDir());
  ledger.freeze('A', 100);
  ledger.enqueue('p1', 'A', 30);
  ledger.enqueue('p2', 'A', 30);
  ledger.enqueue('p3', 'A', 30);
  ledger.freeze('A', 50); // scarcity: only one 30-payment fits
  const r = ledger.settle();
  assert.equal(r.batch, 1);
  assert.deepEqual(r.body.deltas.map((d) => d.id), ['p1']);
  assert.deepEqual(r.body.rejected, ['p2', 'p3']);
  const view = ledger.snapshot().accounts.A;
  assert.equal(view.budget, 20); // 50 - 30 spent
  assert.equal(view.frozen, 60); // p2 + p3 still frozen
  assert.deepEqual(ledger.snapshot().queue, ['p2', 'p3']);
  assert.equal(ledger.state.payments.p1.status, 'settled');
  assert.equal(ledger.state.payments.p1.settleHash, r.hash);
  assert.equal(ledger.verify().ok, true);
});

test('settled payment cannot be cancelled; refund restores budget via reverse block', () => {
  const ledger = new Ledger(tmpLedgerDir());
  ledger.freeze('A', 100);
  ledger.enqueue('p1', 'A', 40);
  const settled = ledger.settle();
  assert.equal(ledger.snapshot().accounts.A.budget, 60);
  assert.throws(() => ledger.cancel('p1'), /already settled.*use refund/);

  const refund = ledger.refund('p1');
  assert.equal(refund.batch, 2);
  assert.equal(refund.body.type, 'refund');
  // Reverse block references the original settlement block hash.
  assert.equal(refund.body.ref, settled.hash);
  assert.equal(refund.body.prevHash, settled.hash);
  // Budget restored to the pre-settle level.
  assert.equal(ledger.snapshot().accounts.A.budget, 100);
  assert.equal(ledger.state.payments.p1.status, 'refunded');
  // Refund is idempotent and cannot be cancelled afterwards.
  assert.equal(ledger.refund('p1').idempotent, true);
  assert.throws(() => ledger.cancel('p1'), /already refunded/);
  assert.equal(ledger.snapshot().accounts.A.budget, 100);
  assert.equal(ledger.verify().ok, true);
});

test('refund of non-settled payment fails', () => {
  const ledger = new Ledger(tmpLedgerDir());
  ledger.freeze('A', 100);
  ledger.enqueue('p1', 'A', 10);
  assert.throws(() => ledger.refund('p1'), /only settled payments/);
  assert.throws(() => ledger.refund('ghost'), /unknown payment/);
});

test('incremental decoding walks the chain batch by batch', () => {
  const ledger = new Ledger(tmpLedgerDir());
  ledger.freeze('A', 1000);
  ledger.enqueue('p1', 'A', 10);
  ledger.settle();
  ledger.enqueue('p2', 'A', 20);
  ledger.settle();
  ledger.refund('p1');

  let reader = { nextBatch: 1, prevHash: GENESIS_HASH };
  const seen = [];
  while (reader.nextBatch <= ledger.index.batches.length) {
    const step = ledger.decodeNext(reader);
    seen.push({ batch: step.body.batch, type: step.body.type, hash: step.hash });
    reader = step.next;
  }
  assert.deepEqual(seen.map((s) => s.batch), [1, 2, 3]);
  assert.deepEqual(seen.map((s) => s.type), ['settle', 'settle', 'refund']);
  // Each decoded hash matches the index entry.
  seen.forEach((s, i) => assert.equal(s.hash, ledger.index.batches[i].hash));
  // Reader cursor ends past the tip, anchored at the last hash.
  assert.equal(reader.nextBatch, 4);
  assert.equal(reader.prevHash, ledger.index.batches[2].hash);
});

test('state persists across ledger reopen', () => {
  const dir = tmpLedgerDir();
  const ledger = new Ledger(dir);
  ledger.freeze('A', 100);
  ledger.enqueue('p1', 'A', 40);
  ledger.settle();
  ledger.enqueue('p2', 'A', 10);

  const reopened = new Ledger(dir);
  assert.equal(reopened.snapshot().accounts.A.budget, 60);
  assert.deepEqual(reopened.snapshot().queue, ['p2']);
  assert.equal(reopened.snapshot().appliedBatch, 1);
  assert.equal(reopened.verify().ok, true);
});

test('settle with empty queue fails', () => {
  const ledger = new Ledger(tmpLedgerDir());
  ledger.freeze('A', 100);
  assert.throws(() => ledger.settle(), /no queued payments/);
});
