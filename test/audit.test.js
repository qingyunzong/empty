import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy, loadStock } from '../src/model.js';
import { audit, minimalMissingConstraints, ALL_CHECKS } from '../src/audit.js';
import { basePolicy, baseStock, batch } from './helpers.js';

function policyAndStock() {
  return { policy: loadPolicy(basePolicy()), stock: loadStock(baseStock()) };
}

test('audit verifies conservation on a generated ledger', () => {
  const { policy, stock } = policyAndStock();
  const { ledger } = batch(basePolicy(), baseStock(), [
    { id: 'D1', sku: 'SKU-E', customer: 'C1', amount: 300 },
    { id: 'D2', sku: 'SKU-P', customer: 'CUST-BAD', amount: 100 },
    { type: 'cancel_rework', defectId: 'D1' },
    { type: 'budget_correction', amount: 10 },
  ]);
  const result = audit(policy, stock, ledger);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('audit flags a tampered non-conserved ledger', () => {
  const { policy, stock } = policyAndStock();
  const { ledger } = batch(basePolicy(), baseStock(), [
    { id: 'D1', sku: 'SKU-E', customer: 'C1', amount: 300 },
  ]);
  ledger[1].budgetAfter -= 5; // tamper: recorded balance no longer matches replay
  const result = audit(policy, stock, ledger);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.check === 'step_conservation'));
});

test('cancel restores stock but never budget; implicit budget restore is flagged', () => {
  const { policy, stock } = policyAndStock();
  const { ledger } = batch(basePolicy(), baseStock(), [
    { id: 'D1', sku: 'SKU-E', customer: 'C1', amount: 300 },
    { type: 'cancel_rework', defectId: 'D1' },
  ]);
  // Forge an implicit budget refund on the cancel event.
  const cancel = ledger.find((l) => l.event === 'rework_canceled');
  cancel.budgetDelta = 10;
  cancel.budgetAfter += 10;
  const result = audit(policy, stock, ledger);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.check === 'budget_increase_only_via_correction'));
});

test('counterexample: minimal missing constraint that lets an over-budget ledger pass', () => {
  const { policy, stock } = policyAndStock();
  // Hand-crafted ledger: internally conserved (deltas match balances) but the
  // budget goes negative — an over-budget pass.
  const ledger = [
    { seq: 0, event: 'init', stockAfter: { 'SKU-A': 5, 'SKU-E': 5, 'SKU-P': 5 }, budgetAfter: 100 },
    { seq: 1, event: 'rework_authorized', defectId: 'D1', sku: 'SKU-E', stockDelta: -1, budgetDelta: -70, stockAfter: { 'SKU-A': 5, 'SKU-E': 4, 'SKU-P': 5 }, budgetAfter: 30 },
    { seq: 2, event: 'rework_authorized', defectId: 'D2', sku: 'SKU-E', stockDelta: -1, budgetDelta: -70, stockAfter: { 'SKU-A': 5, 'SKU-E': 3, 'SKU-P': 5 }, budgetAfter: -40 },
  ];
  const full = audit(policy, stock, ledger);
  assert.equal(full.ok, false);
  assert.ok(full.violations.some((v) => v.check === 'budget_non_negative'));

  // Under a weakened audit (conservation only) the over-budget ledger passes.
  const enforced = ['init_conservation', 'step_conservation'];
  const weakened = audit(policy, stock, ledger, enforced);
  assert.equal(weakened.ok, true);

  const counter = minimalMissingConstraints(policy, stock, ledger, enforced);
  assert.equal(counter.passesUnderEnforced, true);
  assert.deepEqual(counter.minimalMissing, ['budget_non_negative']);
});

test('audit catches cancel without a matching open rework', () => {
  const { policy, stock } = policyAndStock();
  const ledger = [
    { seq: 0, event: 'init', stockAfter: { 'SKU-A': 5, 'SKU-E': 5, 'SKU-P': 5 }, budgetAfter: 100 },
    { seq: 1, event: 'rework_canceled', defectId: 'GHOST', sku: 'SKU-E', stockDelta: 1, budgetDelta: 0, stockAfter: { 'SKU-A': 5, 'SKU-E': 6, 'SKU-P': 5 }, budgetAfter: 100 },
  ];
  const result = audit(policy, stock, ledger);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.check === 'cancel_requires_rework'));
});

test('ALL_CHECKS covers every check the counterexample can name', () => {
  const { policy, stock } = policyAndStock();
  const { ledger } = batch(basePolicy(), baseStock(), [
    { id: 'D1', sku: 'SKU-E', customer: 'C1', amount: 300 },
  ]);
  const counter = minimalMissingConstraints(policy, stock, ledger, ALL_CHECKS);
  assert.equal(counter.passesUnderEnforced, true);
  assert.deepEqual(counter.minimalMissing, []);
});
