// Acceptance B: one side carries extra entries -> removeExtra among the
// optimal scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLedgers } from '../src/index.js';
import { ev, pair } from './helpers.js';

test('B1: left has one extra event -> minCost 1 with removeExtra(left)', () => {
  const left = [...pair('l1', 'l2', { relId: 'r1' }), ev('lx', 'cash', 70, 'debit', 'USD', 'r9')];
  const right = pair('r1', 'r2', { relId: 'r1' });
  const res = diffLedgers(left, right, { k: 5 });
  assert.equal(res.balanced, false);
  assert.equal(res.minCost, 1);
  assert.ok(res.scripts.length >= 1);
  assert.ok(
    res.scripts.some((s) => s.length === 1 && s[0].op === 'removeExtra' && s[0].side === 'left' && s[0].id === 'lx'),
    'expected a removeExtra(left, lx) script',
  );
});

test('B2: left has an extra balanced pair -> minCost 2, removeExtra-only script exists', () => {
  const left = [
    ...pair('l1', 'l2', { relId: 'r1' }),
    ...pair('l3', 'l4', { relId: 'rX', amount: 33, accD: 'cash', accC: 'fee' }),
  ];
  const right = pair('r1', 'r2', { relId: 'r1' });
  const res = diffLedgers(left, right, { k: 5 });
  assert.equal(res.balanced, false);
  assert.equal(res.minCost, 2);
  const removeOnly = res.scripts.find((s) => s.every((op) => op.op === 'removeExtra' && op.side === 'left'));
  assert.ok(removeOnly, 'expected an all-removeExtra script');
  assert.deepEqual(removeOnly.map((op) => op.id).sort(), ['l3', 'l4']);
});

test('B3: right-side surplus mirrors to removeExtra(right)', () => {
  const left = pair('l1', 'l2', { relId: 'r1' });
  const right = [...pair('r1', 'r2', { relId: 'r1' }), ev('rx', 'cash', 12, 'credit', 'USD', 'rZ')];
  const res = diffLedgers(left, right, { k: 5 });
  assert.equal(res.minCost, 1);
  assert.ok(res.scripts.some((s) => s[0].op === 'removeExtra' && s[0].side === 'right' && s[0].id === 'rx'));
});
