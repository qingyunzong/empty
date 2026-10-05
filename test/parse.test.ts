import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, treeYield, verifyCertificate } from '../src/index';

test('simple grammar: finds the known optimum and the rule-id sequence', () => {
  const grammar = {
    start: 'S',
    rules: [
      { id: 1, lhs: 'S', rhs: ['A', 'B'], cost: 1 },
      { id: 2, lhs: 'A', rhs: ['a'], cost: 2 },
      { id: 3, lhs: 'B', rhs: ['b'], cost: 3 },
    ],
  };
  const res = parse(grammar, ['a', 'b']);
  assert.equal(res.status, 'optimal');
  if (res.status === 'infeasible') return;
  assert.equal(res.cost, 6);
  assert.deepEqual(res.ruleIds, [1, 2, 3]);
  assert.deepEqual(treeYield(res.tree), ['a', 'b']);
  assert.deepEqual(verifyCertificate(grammar, res.certificate), { ok: true });
});

test('ambiguous grammar: the cheaper of two parses wins', () => {
  // "a a a" via left-leaning (cost 1 per join) vs right-leaning (cost 5 per join).
  const grammar = {
    start: 'S',
    rules: [
      { id: 1, lhs: 'S', rhs: ['S', 'T'], cost: 1 },
      { id: 2, lhs: 'S', rhs: ['T', 'S'], cost: 5 },
      { id: 3, lhs: 'S', rhs: ['T'], cost: 0 },
      { id: 4, lhs: 'T', rhs: ['a'], cost: 1 },
    ],
  };
  const res = parse(grammar, ['a', 'a', 'a']);
  assert.equal(res.status, 'optimal');
  if (res.status === 'infeasible') return;
  // three leaves (3*1) + two cheap joins (2*1)
  assert.equal(res.cost, 5);
  assert.deepEqual(res.ruleIds, [1, 1, 3, 4, 4, 4]);
  assert.deepEqual(verifyCertificate(grammar, res.certificate), { ok: true });
});

test('recursive rules: unbounded repetition terminates with the minimum', () => {
  const grammar = {
    start: 'S',
    rules: [
      { id: 1, lhs: 'S', rhs: ['S', 'S'], cost: 1 },
      { id: 2, lhs: 'S', rhs: ['a'], cost: 2 },
    ],
  };
  const res = parse(grammar, ['a', 'a', 'a', 'a']);
  assert.equal(res.status, 'optimal');
  if (res.status === 'infeasible') return;
  // 4 leaves * 2 + 3 internal nodes * 1
  assert.equal(res.cost, 11);
  assert.deepEqual(verifyCertificate(grammar, res.certificate), { ok: true });
});

test('zero-cost cycles do not hang and do not lower the cost', () => {
  const grammar = {
    start: 'S',
    rules: [
      { id: 1, lhs: 'S', rhs: ['A'], cost: 0 },
      { id: 2, lhs: 'A', rhs: ['S'], cost: 0 },
      { id: 3, lhs: 'A', rhs: ['a'], cost: 1 },
    ],
  };
  const res = parse(grammar, ['a']);
  assert.equal(res.status, 'optimal');
  if (res.status === 'infeasible') return;
  assert.equal(res.cost, 1);
  assert.deepEqual(verifyCertificate(grammar, res.certificate), { ok: true });
});

test('epsilon rules and the empty sequence', () => {
  const grammar = {
    start: 'S',
    rules: [
      { id: 1, lhs: 'S', rhs: ['A', 'x', 'A'], cost: 0 },
      { id: 2, lhs: 'A', rhs: [], cost: 0 },
      { id: 3, lhs: 'A', rhs: ['y'], cost: 1 },
    ],
  };
  const empty = parse(grammar, []);
  assert.equal(empty.status, 'infeasible'); // S always produces an 'x'

  const justX = parse(grammar, ['x']);
  assert.equal(justX.status, 'optimal');
  if (justX.status === 'infeasible') return;
  assert.equal(justX.cost, 0);
  assert.deepEqual(justX.ruleIds, [1, 2, 2]);

  const xyx = parse(grammar, ['y', 'x', 'y']);
  assert.equal(xyx.status, 'optimal');
  if (xyx.status === 'infeasible') return;
  assert.equal(xyx.cost, 2);
});

test('infeasible is exact and distinguished from over-budget', () => {
  const grammar = {
    start: 'S',
    rules: [
      { id: 1, lhs: 'S', rhs: ['a'], cost: 5 },
    ],
  };
  // No derivation exists at all -> infeasible (never "budget unknown").
  const none = parse(grammar, ['b']);
  assert.equal(none.status, 'infeasible');

  // Derivation exists but is too expensive -> over-budget, not infeasible.
  const poor = parse(grammar, ['a'], { budget: 4 });
  assert.equal(poor.status, 'over-budget');
  if (poor.status === 'infeasible') return;
  assert.equal(poor.cost, 5);
  assert.equal(poor.budget, 4);

  // Fits the budget -> optimal.
  const rich = parse(grammar, ['a'], { budget: 5 });
  assert.equal(rich.status, 'optimal');
});

test('input validation rejects malformed grammars and budgets', () => {
  const base = { start: 'S', rules: [{ id: 1, lhs: 'S', rhs: ['a'], cost: 1 }] };
  assert.throws(() => parse({ start: 'S', rules: [{ id: 1, lhs: 'S', rhs: ['a'], cost: -1 }] }, ['a']), /non-negative/);
  assert.throws(() => parse({ start: 'S', rules: [{ id: 1, lhs: 'S', rhs: ['a'], cost: Number.NaN }] }, ['a']), /non-negative finite/);
  assert.throws(() => parse({ start: 'S', rules: [
    { id: 1, lhs: 'S', rhs: ['a'], cost: 1 },
    { id: 1, lhs: 'S', rhs: ['b'], cost: 1 },
  ] }, ['a']), /duplicate rule id/);
  assert.throws(() => parse(base, ['a'], { budget: -1 }), /budget/);
  assert.throws(() => parse(base, ['']), /non-empty/);
});
