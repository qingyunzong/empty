import test from 'node:test';
import assert from 'node:assert/strict';
import { basePolicy, baseStock, batch } from './helpers.js';

test('severity is inherited from the product category, not the defect', () => {
  const { decisions } = batch(basePolicy(), baseStock(), [
    { id: 'D1', sku: 'SKU-P', customer: 'C1', amount: 600 },
  ]);
  assert.equal(decisions[0].severity, 'critical'); // pharma category
  assert.equal(decisions[0].action, 'scrap'); // critical is not reworkable
  assert.match(decisions[0].reason, /severity_not_reworkable/);
});

test('A: customer blacklist overrides concession even below the amount threshold', () => {
  const { decisions } = batch(basePolicy(), baseStock(), [
    { id: 'D1', sku: 'SKU-P', customer: 'CUST-BAD', amount: 100 },
    { id: 'D2', sku: 'SKU-P', customer: 'CUST-OK', amount: 100 },
  ]);
  const bad = decisions.find((d) => d.id === 'D1');
  const ok = decisions.find((d) => d.id === 'D2');
  assert.equal(bad.action, 'scrap');
  assert.match(bad.reason, /blacklist_priority/);
  assert.equal(ok.action, 'concession');
  assert.match(ok.reason, /amount_below_threshold/);
});

test('amount threshold: above scraps, equal is a tie and rejected', () => {
  const { decisions } = batch(basePolicy(), baseStock(), [
    { id: 'D1', sku: 'SKU-P', customer: 'C1', amount: 501 },
    { id: 'D2', sku: 'SKU-P', customer: 'C1', amount: 500 },
    { id: 'D3', sku: 'SKU-P', customer: 'C1', amount: 499 },
  ]);
  assert.equal(decisions.find((d) => d.id === 'D1').action, 'scrap');
  assert.match(decisions.find((d) => d.id === 'D1').reason, /amount_above_threshold/);
  assert.equal(decisions.find((d) => d.id === 'D2').action, 'scrap');
  assert.match(decisions.find((d) => d.id === 'D2').reason, /tie_rejected/);
  assert.equal(decisions.find((d) => d.id === 'D3').action, 'concession');
});

test('B: canceling rework restores stock but NOT budget; explicit correction restores budget', () => {
  const stock = baseStock();
  const { decisions, ledger } = batch(basePolicy(), stock, [
    { id: 'D1', sku: 'SKU-E', customer: 'C1', amount: 300 },
    { type: 'cancel_rework', defectId: 'D1', reason: 'customer refused rework' },
  ]);
  assert.equal(decisions[0].action, 'rework');
  const init = ledger[0];
  const authorized = ledger.find((l) => l.event === 'rework_authorized');
  const canceled = ledger.find((l) => l.event === 'rework_canceled');
  assert.equal(authorized.stockAfter['SKU-E'], init.stockAfter['SKU-E'] - 1);
  assert.equal(authorized.budgetAfter, init.budgetAfter - 10);
  // Stock returned, budget still spent.
  assert.equal(canceled.stockAfter['SKU-E'], init.stockAfter['SKU-E']);
  assert.equal(canceled.budgetAfter, init.budgetAfter - 10);
  assert.equal(canceled.budgetDelta, 0);

  const withCorrection = batch(basePolicy(), stock, [
    { id: 'D1', sku: 'SKU-E', customer: 'C1', amount: 300 },
    { type: 'cancel_rework', defectId: 'D1' },
    { type: 'budget_correction', amount: 10, reason: 'finance approved refund' },
  ]);
  const last = withCorrection.ledger.at(-1);
  assert.equal(last.event, 'budget_correction');
  assert.equal(last.budgetAfter, 100); // budget restored only via the explicit event
});

test('C: equal-value ties under a binding budget resolve deterministically by id', () => {
  const policy = basePolicy();
  policy.rework.shiftBudget = { amount: 10, currency: 'CNY' }; // fits exactly one rework
  const events = [
    { id: 'D2', sku: 'SKU-E', customer: 'C1', amount: 300 },
    { id: 'D1', sku: 'SKU-A', customer: 'C1', amount: 300 },
  ];
  const first = batch(policy, baseStock(), events);
  const second = batch(policy, baseStock(), [...events].reverse());
  for (const { decisions } of [first, second]) {
    assert.equal(decisions.find((d) => d.id === 'D1').action, 'rework');
    assert.equal(decisions.find((d) => d.id === 'D2').action, 'concession');
  }
});

test('C: equal-value ties under a binding per-sku stock cap resolve deterministically', () => {
  const stock = { items: [{ sku: 'SKU-E', category: 'electronics', onHand: 1 }] };
  const { decisions } = batch(basePolicy(), stock, [
    { id: 'D9', sku: 'SKU-E', customer: 'C1', amount: 300 },
    { id: 'D1', sku: 'SKU-E', customer: 'C1', amount: 300 },
  ]);
  assert.equal(decisions.find((d) => d.id === 'D1').action, 'rework');
  assert.equal(decisions.find((d) => d.id === 'D9').action, 'concession');
});

test('dual constraint: budget and stock both bind the authorization set', () => {
  const policy = basePolicy();
  policy.rework.shiftBudget = { amount: 20, currency: 'CNY' }; // two reworks by budget
  const stock = { items: [{ sku: 'SKU-E', category: 'electronics', onHand: 1 }] }; // one by stock
  const { decisions, ledger } = batch(policy, stock, [
    { id: 'D1', sku: 'SKU-E', customer: 'C1', amount: 900 },
    { id: 'D2', sku: 'SKU-E', customer: 'C1', amount: 800 },
  ]);
  assert.equal(decisions.filter((d) => d.action === 'rework').length, 1);
  assert.equal(decisions[0].id, 'D1'); // higher net value wins the single stock unit
  assert.equal(ledger.at(-1).stockAfter['SKU-E'], 0);
  assert.equal(ledger.at(-1).budgetAfter, 10);
});
