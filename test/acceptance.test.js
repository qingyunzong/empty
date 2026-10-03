'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../lib/model');
const { run, createState, beginAttempt, commitFreeze, recover } = require('../lib/engine');

const B1 = { id: 'B1', start: '2026-10-03T00:00:00Z', end: '2026-10-03T01:00:00Z' };
const B2 = { id: 'B2', start: '2026-10-03T02:00:00Z', end: '2026-10-03T03:00:00Z' };

function maxFrozenPerAccountBatch(journal) {
  const current = new Map();
  let max = 0;
  for (const e of journal) {
    const key = e.tx !== undefined && e.batch ? e.batch : null;
    if (e.type === 'freeze' || e.type === 'unfreeze') {
      const k = `${e.tx}|${e.batch}`;
      const next = (current.get(k) || 0) + (e.type === 'freeze' ? e.amount : -e.amount);
      current.set(k, next);
      if (next > max) max = next;
    }
  }
  return max;
}

test('acceptance 1: three transactions split across batches all succeed', () => {
  const model = normalize({
    accounts: [{ id: 'A', limit: 100 }],
    batches: [B1, B2],
    transactions: [
      { id: 'T1', account: 'A', amount: 60 },
      { id: 'T2', account: 'A', amount: 60 },
      { id: 'T3', account: 'A', amount: 40 },
    ],
  });
  const out = run(model);
  assert.equal(out.status, 'OK');
  assert.deepEqual(out.transactions.map((t) => t.status), ['SUCCESS', 'SUCCESS', 'SUCCESS']);
  const usedBatches = new Set(out.transactions.flatMap((t) => t.attempts.map((a) => a.batch)));
  assert.deepEqual([...usedBatches].sort(), ['B1', 'B2']);
  // same account, same batch: total frozen never exceeds the limit
  const perBatch = new Map();
  for (const t of out.transactions) {
    for (const a of t.attempts) {
      const k = `${t.account}|${a.batch}`;
      perBatch.set(k, (perBatch.get(k) || 0) + t.amount);
    }
  }
  for (const total of perBatch.values()) assert.ok(total <= 100);
  assert.ok(maxFrozenPerAccountBatch(out.journal) <= 100);
  // each transaction succeeded exactly once and was never retried afterwards
  for (const t of out.transactions) {
    assert.equal(t.attempts.length, 1);
    assert.equal(t.attempts[0].result, 'SUCCESS');
  }
});

test('acceptance 2: cancellation incrementally removes later batches', () => {
  const model = normalize({
    accounts: [{ id: 'A', limit: 100 }],
    batches: [B1, B2],
    transactions: [
      { id: 'T1', account: 'A', amount: 10, failures: ['B1'] },
      { id: 'T2', account: 'A', amount: 10, failures: ['B1'] },
    ],
    cancellations: [{ tx: 'T2', atBatch: 'B2' }],
  });
  const out = run(model);
  const t1 = out.transactions.find((t) => t.id === 'T1');
  const t2 = out.transactions.find((t) => t.id === 'T2');
  assert.equal(t1.status, 'SUCCESS');
  assert.deepEqual(t1.attempts.map((a) => a.batch), ['B1', 'B2']);
  assert.equal(t2.status, 'CANCELLED');
  assert.deepEqual(t2.attempts.map((a) => a.batch), ['B1']);
  // the not-yet-started B2 attempt was removed before the cancel was applied
  const removed = out.journal.find((e) => e.type === 'attempt-removed' && e.tx === 'T2');
  const cancelled = out.journal.find((e) => e.type === 'cancelled' && e.tx === 'T2');
  assert.ok(removed && removed.batch === 'B2');
  assert.ok(cancelled);
  assert.ok(removed.seq < cancelled.seq);
  // failed attempt unfroze its amount before the retry
  const unfreeze = out.journal.find((e) => e.type === 'unfreeze' && e.tx === 'T1' && e.batch === 'B1');
  assert.ok(unfreeze && unfreeze.amount === 10);
});

test('cancellation during a running batch unfreezes and cancels the attempt', () => {
  const model = normalize({
    accounts: [{ id: 'A', limit: 100 }],
    batches: [B1, B2],
    transactions: [{ id: 'T1', account: 'A', amount: 10 }],
    cancellations: [{ tx: 'T1', atBatch: 'B1', phase: 'during' }],
  });
  const out = run(model);
  const t1 = out.transactions[0];
  assert.equal(t1.status, 'CANCELLED');
  assert.equal(t1.attempts.length, 1);
  assert.equal(t1.attempts[0].result, 'CANCELLED');
  assert.equal(t1.attempts[0].freezeCommitted, true);
  assert.ok(out.journal.some((e) => e.type === 'unfreeze' && e.reason === 'cancel'));
  assert.ok(!out.journal.some((e) => e.type === 'success'));
});

test('acceptance 3: crash after RUNNING before freeze recovers to PENDING', () => {
  const model = normalize({
    accounts: [{ id: 'A', limit: 100 }],
    batches: [B1],
    transactions: [{ id: 'T1', account: 'A', amount: 10 }],
  });
  const state = createState(model);
  beginAttempt(state, 'T1', 'B1');
  assert.equal(state.txs.get('T1').status, 'RUNNING');
  // crash: only the committed journal survives
  const recovered = recover(model, state.journal);
  const tx = recovered.txs.get('T1');
  assert.equal(tx.status, 'PENDING');
  assert.notEqual(tx.status, 'SUCCESS');
  assert.ok(recovered.journal.some((e) => e.type === 'recovered' && e.tx === 'T1'));
  // safe retry is allowed and completes exactly once
  const out = run(model, { state: recovered });
  assert.equal(out.status, 'OK');
  assert.equal(out.journal.filter((e) => e.type === 'success' && e.tx === 'T1').length, 1);
});

test('crash after freeze commit but before outcome also recovers to PENDING', () => {
  const model = normalize({
    accounts: [{ id: 'A', limit: 100 }],
    batches: [B1],
    transactions: [{ id: 'T1', account: 'A', amount: 10 }],
  });
  const state = createState(model);
  beginAttempt(state, 'T1', 'B1');
  commitFreeze(state, 'T1', 'B1');
  const recovered = recover(model, state.journal);
  assert.equal(recovered.txs.get('T1').status, 'PENDING');
  // the uncommitted freeze was rolled back, so the retry does not double-freeze
  assert.ok(recovered.journal.some((e) => e.type === 'unfreeze' && e.reason === 'recovery'));
  const out = run(model, { state: recovered });
  assert.equal(out.status, 'OK');
  assert.equal(out.journal.filter((e) => e.type === 'freeze' && e.tx === 'T1').length, 1);
});

test('acceptance 4: insufficient limit is UNSAT with a minimal account-batch conflict', () => {
  const model = normalize({
    accounts: [{ id: 'A', limit: 50 }],
    batches: [B1, B2],
    transactions: [{ id: 'T1', account: 'A', amount: 100 }],
  });
  const out = run(model);
  assert.equal(out.status, 'UNSAT');
  assert.deepEqual(out.conflict, [
    { account: 'A', batch: 'B1' },
    { account: 'A', batch: 'B2' },
  ]);
  assert.equal(out.transactions[0].status, 'UNSAT');
});

test('conflict explanation is the minimal account-batch set', () => {
  const model = normalize({
    accounts: [{ id: 'A', limit: 100 }],
    batches: [B1, B2],
    transactions: [
      { id: 'T1', account: 'A', amount: 60, routes: ['B1'] },
      { id: 'T2', account: 'A', amount: 60, routes: ['B1'] },
      { id: 'T3', account: 'A', amount: 60 },
    ],
  });
  const out = run(model);
  assert.equal(out.status, 'UNSAT');
  assert.deepEqual(out.conflict, [{ account: 'A', batch: 'B1' }]);
});

test('retry only happens inside allowed time windows', () => {
  const model = normalize({
    accounts: [{ id: 'A', limit: 100 }],
    batches: [B1, B2],
    transactions: [
      {
        id: 'T1',
        account: 'A',
        amount: 10,
        failures: ['B1'],
        windows: [[B1.start, B1.end]],
      },
    ],
  });
  const out = run(model);
  // B2 is outside the allowed window, so the failed transaction cannot retry
  assert.equal(out.status, 'UNSAT');
  assert.deepEqual(out.transactions[0].attempts.map((a) => a.batch), ['B1']);
});
