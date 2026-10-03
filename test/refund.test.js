import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  Store,
  ERR_BUDGET_EXCEEDED,
  ERR_UNKNOWN_TRADE,
  ERR_TRADE_ALREADY_UNDONE,
} from '../src/store.js';
import { tmpdir } from './helpers.js';

const EVENTS = [
  { id: 'e1', tradeId: 't1', fee: 30, refundBudget: 100, text: 'alpha beta', state: 'open' },
  { id: 'e2', tradeId: 't1', fee: 20, refundBudget: 100, text: 'beta gamma', state: 'open' },
  { id: 'e3', tradeId: 't2', fee: 50, refundBudget: 40, text: 'gamma delta', state: 'open' },
  { id: 'e4', tradeId: 't3', fee: 10, refundBudget: 60, text: 'delta epsilon', state: 'open' },
  { id: 'e5', tradeId: 't3', fee: 15, refundBudget: 60, text: 'epsilon zeta', state: 'open' },
];

function groupByTrade(events) {
  const groups = {};
  for (const event of events) {
    const group = (groups[event.tradeId] ??= { fee: 0, budget: 0 });
    group.fee += event.fee;
    group.budget = Math.max(group.budget, event.refundBudget);
  }
  return groups;
}

test('refund totals and remaining budget match independent group-by-tradeId sums', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  for (const event of EVENTS) store.append(event);

  const expected = groupByTrade(EVENTS);
  const r1 = store.undoTrade('t1');
  const r3 = store.undoTrade('t3');

  assert.equal(r1.refunded, expected.t1.fee);
  assert.equal(r1.budgetRemaining, expected.t1.budget - expected.t1.fee);
  assert.equal(r3.refunded, expected.t3.fee);
  assert.equal(r3.budgetRemaining, expected.t3.budget - expected.t3.fee);

  const reopened = Store.open(dir);
  assert.equal(reopened.refunds.get('t1').amount, expected.t1.fee);
  assert.equal(reopened.refunds.get('t1').budgetAfter, expected.t1.budget - expected.t1.fee);
  assert.equal(reopened.refunds.get('t3').amount, expected.t3.fee);
  assert.equal(reopened.refunds.get('t3').budgetAfter, expected.t3.budget - expected.t3.fee);
});

test('insufficient budget refunds nothing and keeps pre-undo state across restart', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  for (const event of EVENTS) store.append(event);
  const phraseBefore = store.queryPhrase('gamma delta');
  const liveBefore = store.liveEvents().map((e) => e.id);

  assert.throws(
    () => store.undoTrade('t2'),
    (err) => err.code === ERR_BUDGET_EXCEEDED,
  );
  assert.equal(store.refunds.size, 0);

  store = Store.open(dir);
  assert.equal(store.refunds.size, 0);
  assert.deepEqual(store.queryPhrase('gamma delta'), phraseBefore);
  assert.deepEqual(store.liveEvents().map((e) => e.id), liveBefore);
  const refundsFile = path.join(dir, 'refunds.jsonl');
  assert.equal(fs.existsSync(refundsFile) ? fs.readFileSync(refundsFile, 'utf8') : '', '');
});

test('unknown trade returns agreed error and keeps pre-undo state across restart', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  for (const event of EVENTS) store.append(event);
  const statsBefore = store.stats();

  assert.throws(
    () => store.undoTrade('no-such-trade'),
    (err) => err.code === ERR_UNKNOWN_TRADE,
  );

  store = Store.open(dir);
  assert.deepEqual(store.stats(), statsBefore);
});

test('undoing the same trade twice returns agreed error', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  for (const event of EVENTS) store.append(event);
  store.undoTrade('t1');
  assert.throws(
    () => store.undoTrade('t1'),
    (err) => err.code === ERR_TRADE_ALREADY_UNDONE,
  );
  const refunds = fs.readFileSync(path.join(dir, 'refunds.jsonl'), 'utf8')
    .trim().split('\n');
  assert.equal(refunds.length, 1);
});
