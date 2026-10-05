// Acceptance A: fully balanced ledgers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLedgers, ProductAutomaton } from '../src/index.js';
import { ev, pair } from './helpers.js';

test('A1: identical balanced ledgers -> balanced', () => {
  const left = [...pair('l1', 'l2', { relId: 'r1' }), ...pair('l3', 'l4', { relId: 'r2', amount: 40, currency: 'EUR' })];
  const right = [...pair('r1', 'r2', { relId: 'r1' }), ...pair('r3', 'r4', { relId: 'r2', amount: 40, currency: 'EUR' })];
  const res = diffLedgers(left, right, { k: 5 });
  assert.equal(res.balanced, true);
  assert.deepEqual(res.scripts, []);
  assert.equal(res.minCost, 0);
  assert.equal(res.certificate, null);
  assert.equal(res.error, null);
});

test('A2: reordered across accounts (per-account causality preserved) -> balanced', () => {
  const left = [
    ev('a', 'cash', 100, 'debit', 'USD', 'r1'),
    ev('b', 'cash', 50, 'debit', 'USD', 'r2'),
    ev('c', 'revenue', 100, 'credit', 'USD', 'r1'),
    ev('d', 'revenue', 50, 'credit', 'USD', 'r2'),
  ];
  // Right interleaves differently but keeps cash: x<y and revenue: z<w order.
  const right = [
    ev('z', 'revenue', 100, 'credit', 'USD', 'r1'),
    ev('x', 'cash', 100, 'debit', 'USD', 'r1'),
    ev('w', 'revenue', 50, 'credit', 'USD', 'r2'),
    ev('y', 'cash', 50, 'debit', 'USD', 'r2'),
  ];
  const res = diffLedgers(left, right, { k: 5 });
  assert.equal(res.balanced, true);
});

test('A3: product automaton finds an accepting joint run for a balanced pair', () => {
  const left = [...pair('l1', 'l2', { relId: 'r1' })];
  const right = [...pair('r1', 'r2', { relId: 'r1' })];
  const found = new ProductAutomaton(left, right).findAcceptingPath();
  assert.ok(found && Array.isArray(found.path));
  assert.equal(found.path.length, 4);
});

test('A4: empty ledgers are balanced', () => {
  const res = diffLedgers([], [], { k: 5 });
  assert.equal(res.balanced, true);
});

test('A5: non-zero per-currency total -> not balanced', () => {
  const left = [ev('a', 'cash', 100, 'debit', 'USD', 'r1')];
  const right = [ev('b', 'cash', 100, 'debit', 'USD', 'r1')];
  const res = diffLedgers(left, right, { k: 5 });
  assert.equal(res.balanced, false);
  assert.equal(res.certificate.reason, 'INTERNAL_IMBALANCE');
});
