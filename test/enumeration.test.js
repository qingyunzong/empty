'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reserve } = require('../lib/reserve');
const { TIERS } = require('../lib/solver');

function occupancy(expense, tierIndex) {
  const tierAmount = Math.round(expense.amount * 100 * TIERS[tierIndex].ratio);
  const paid = Math.round((expense.paid ?? 0) * 100);
  return Math.max(paid, tierAmount);
}

function bruteForce(envelopes, expenses) {
  const feasible = [];
  const chosen = new Array(expenses.length).fill(null);
  function checkPartial(upto) {
    for (const env of envelopes) {
      let used = 0;
      for (let i = 0; i <= upto; i++) {
        if (chosen[i] && chosen[i].envelopeId === env.id) {
          used += occupancy(expenses[i], chosen[i].tierIndex);
        }
      }
      if (used > Math.round(env.limit * 100)) return false;
    }
    for (let i = 0; i <= upto; i++) {
      for (let j = i + 1; j <= upto; j++) {
        const gi = expenses[i].group;
        if (gi && gi === expenses[j].group && chosen[i].envelopeId !== chosen[j].envelopeId) {
          return false;
        }
      }
    }
    return true;
  }
  function walk(i) {
    if (i === expenses.length) {
      feasible.push(chosen.map((c) => ({ ...c })));
      return;
    }
    for (let tierIndex = 0; tierIndex < TIERS.length; tierIndex++) {
      for (const env of envelopes) {
        if (env.category !== expenses[i].category) continue;
        chosen[i] = { envelopeId: env.id, tierIndex };
        if (checkPartial(i)) walk(i + 1);
      }
    }
    chosen[i] = null;
  }
  walk(0);
  return feasible;
}

function assertSolverMatchesBruteForce(input) {
  const result = reserve(input);
  const feasible = bruteForce(input.envelopes, input.expenses);
  assert.equal(
    result.status,
    feasible.length > 0 ? 'OK' : 'UNSAT',
    `status mismatch, brute force found ${feasible.length} combos`,
  );
  if (result.status !== 'OK') return;
  const byExpense = new Map(result.assignments.map((a) => [a.expenseId, a]));
  for (const env of input.envelopes) {
    let used = 0;
    for (const a of result.assignments) {
      if (a.envelopeId === env.id) used += Math.round(a.reserved * 100);
    }
    assert.ok(used <= Math.round(env.limit * 100), `envelope ${env.id} over limit`);
  }
  for (const expense of input.expenses) {
    const a = byExpense.get(expense.id);
    assert.ok(a, `missing assignment for ${expense.id}`);
    const env = input.envelopes.find((e) => e.id === a.envelopeId);
    assert.equal(env.category, expense.category);
    const tierIndex = TIERS.findIndex((t) => t.name === a.tier);
    assert.equal(Math.round(a.reserved * 100), occupancy(expense, tierIndex));
  }
  for (let i = 0; i < input.expenses.length; i++) {
    for (let j = i + 1; j < input.expenses.length; j++) {
      const gi = input.expenses[i].group;
      if (gi && gi === input.expenses[j].group) {
        assert.equal(byExpense.get(input.expenses[i].id).envelopeId, byExpense.get(input.expenses[j].id).envelopeId);
      }
    }
  }
}

test('cross-check: 2 envelopes x 3 expenses, all tiers enumerated', () => {
  assertSolverMatchesBruteForce({
    envelopes: [
      { id: 'E1', category: 'travel', limit: 150 },
      { id: 'E2', category: 'travel', limit: 90 },
    ],
    expenses: [
      { id: 'R1', category: 'travel', amount: 100 },
      { id: 'R2', category: 'travel', amount: 80 },
      { id: 'R3', category: 'travel', amount: 60 },
    ],
  });
});

test('cross-check: 3 envelopes x 3 expenses with group and paid parts', () => {
  assertSolverMatchesBruteForce({
    envelopes: [
      { id: 'E1', category: 'travel', limit: 120 },
      { id: 'E2', category: 'travel', limit: 100 },
      { id: 'E3', category: 'meals', limit: 50 },
    ],
    expenses: [
      { id: 'R1', category: 'travel', amount: 90, paid: 20, group: 'G1' },
      { id: 'R2', category: 'travel', amount: 70, group: 'G1' },
      { id: 'R3', category: 'meals', amount: 60, paid: 5 },
    ],
  });
});

test('cross-check: brute-force-infeasible case is UNSAT', () => {
  assertSolverMatchesBruteForce({
    envelopes: [
      { id: 'E1', category: 'travel', limit: 40 },
      { id: 'E2', category: 'travel', limit: 30 },
    ],
    expenses: [
      { id: 'R1', category: 'travel', amount: 100, paid: 45 },
      { id: 'R2', category: 'travel', amount: 50 },
      { id: 'R3', category: 'travel', amount: 50 },
    ],
  });
});

test('cross-check: unique feasible combination is found exactly', () => {
  const result = reserve({
    envelopes: [{ id: 'E1', category: 'travel', limit: 50 }],
    expenses: [{ id: 'R1', category: 'travel', amount: 100, paid: 50 }],
  });
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.assignments, [
    { expenseId: 'R1', envelopeId: 'E1', tier: 'DEFERRED', reserved: 50 },
  ]);
});
