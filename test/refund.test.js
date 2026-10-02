import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OrderStore,
  StoreError,
  ERR_UNKNOWN_TRADE,
  ERR_INSUFFICIENT_BUDGET,
} from '../src/store.js';
import { rng, independentRefundReport } from '../testutil/helpers.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oes-refund-'));
}

function makeEvents(seed, nTrades, nEvents) {
  const rand = rng(seed);
  const events = [];
  for (let i = 0; i < nEvents; i++) {
    const tradeId = `T${Math.floor(rand() * nTrades)}`;
    events.push({
      id: `e${i}`,
      tradeId,
      fee: 1 + Math.floor(rand() * 50),
      refundBudget: 100000, // generous; budget-limit case is tested separately
      text: `order ${i} for trade ${tradeId}`,
      state: 'open',
    });
  }
  return events;
}

test('refund totals and remaining budget match independent group-by sums', async () => {
  const dir = tmpdir();
  const store = await OrderStore.open(dir);
  const events = makeEvents(42, 8, 200);
  for (const ev of events) store.addEvent(ev);

  const undone = new Set(['T0', 'T3', 'T5']);
  const results = {};
  for (const tradeId of undone) {
    results[tradeId] = store.undoTrade(tradeId);
  }

  const expected = independentRefundReport(events, undone);
  const report = store.report().trades;
  for (const [tradeId, exp] of Object.entries(expected)) {
    assert.ok(report[tradeId], `report missing ${tradeId}`);
    assert.equal(report[tradeId].feeTotal, exp.feeTotal, `${tradeId} feeTotal`);
    assert.equal(report[tradeId].refundedTotal, exp.refundedTotal, `${tradeId} refundedTotal`);
    assert.equal(report[tradeId].budget, exp.budget, `${tradeId} budget`);
    assert.equal(report[tradeId].budgetRemaining, exp.budgetRemaining, `${tradeId} budgetRemaining`);
  }
  for (const tradeId of undone) {
    assert.equal(results[tradeId].refunded, expected[tradeId].feeTotal);
    assert.equal(results[tradeId].budgetRemaining, expected[tradeId].budgetRemaining);
  }

  // Refund state survives a restart (refund records are durable).
  await store.close();
  const reopened = await OrderStore.open(dir);
  assert.deepEqual(reopened.report(), store.report());
  await reopened.close();
});

test('insufficient budget refunds nothing and leaves state untouched', async () => {
  const dir = tmpdir();
  const store = await OrderStore.open(dir);
  store.addEvent({ id: 'a', tradeId: 'TX', fee: 60, refundBudget: 100, text: 'x', state: 'open' });
  store.addEvent({ id: 'b', tradeId: 'TX', fee: 50, refundBudget: 100, text: 'y', state: 'open' });

  const before = store.report();
  assert.throws(
    () => store.undoTrade('TX'),
    (err) => err instanceof StoreError && err.code === ERR_INSUFFICIENT_BUDGET,
  );
  assert.deepEqual(store.report(), before, 'state must be identical after failed undo');
  assert.equal(store.events.get('a').state, 'open');
  assert.equal(store.events.get('b').state, 'open');

  // Budget exactly sufficient succeeds and refunds everything at once.
  store.addEvent({ id: 'c', tradeId: 'TY', fee: 40, refundBudget: 100, text: 'z', state: 'open' });
  const ok = store.undoTrade('TY');
  assert.equal(ok.refunded, 40);
  assert.equal(ok.budgetRemaining, 60);
  await store.close();
});

test('unknown tradeId returns agreed error and changes nothing', async () => {
  const dir = tmpdir();
  const store = await OrderStore.open(dir);
  store.addEvent({ id: 'a', tradeId: 'T1', fee: 10, refundBudget: 50, text: 'hello', state: 'open' });
  const before = store.report();
  assert.throws(
    () => store.undoTrade('NOPE'),
    (err) => err instanceof StoreError && err.code === ERR_UNKNOWN_TRADE,
  );
  assert.deepEqual(store.report(), before);
  await store.close();
});

test('deleted events are excluded from refund sums', async () => {
  const dir = tmpdir();
  const store = await OrderStore.open(dir);
  store.addEvent({ id: 'a', tradeId: 'T1', fee: 30, refundBudget: 100, text: 'p', state: 'open' });
  store.addEvent({ id: 'b', tradeId: 'T1', fee: 20, refundBudget: 100, text: 'q', state: 'open' });
  await store.delete('b');
  const res = store.undoTrade('T1');
  assert.equal(res.refunded, 30);
  assert.equal(res.budgetRemaining, 70);
  await store.close();
});
