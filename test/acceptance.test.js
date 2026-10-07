'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reserve, InputError } = require('../lib/reserve');

test('acceptance 1: related expenses are placed in the same envelope', () => {
  const result = reserve({
    envelopes: [
      { id: 'E1', category: 'travel', limit: 200 },
      { id: 'E2', category: 'travel', limit: 150 },
    ],
    expenses: [
      { id: 'R1', category: 'travel', amount: 120, group: 'G1' },
      { id: 'R2', category: 'travel', amount: 60, group: 'G1' },
    ],
  });
  assert.equal(result.status, 'OK');
  const byId = new Map(result.assignments.map((a) => [a.expenseId, a]));
  assert.equal(byId.get('R1').envelopeId, byId.get('R2').envelopeId);
  assert.equal(byId.get('R1').envelopeId, 'E1');
  assert.equal(byId.get('R1').tier, 'FULL');
  assert.equal(byId.get('R2').tier, 'FULL');
  const e1 = result.envelopes.find((e) => e.id === 'E1');
  assert.equal(e1.used, 180);
  assert.equal(e1.remaining, 20);
});

test('acceptance 2: cancellation frees capacity so a new expense is accepted', () => {
  const result = reserve({
    envelopes: [{ id: 'E1', category: 'travel', limit: 100 }],
    expenses: [
      { id: 'R1', category: 'travel', amount: 100, paid: 30 },
      { id: 'R2', category: 'travel', amount: 100 },
    ],
    cancellations: [{ expenseId: 'R1' }],
  });
  assert.equal(result.status, 'OK');
  const r2 = result.assignments.find((a) => a.expenseId === 'R2');
  assert.equal(r2.tier, 'FULL');
  assert.equal(r2.envelopeId, 'E1');
  assert.equal(result.assignments.some((a) => a.expenseId === 'R1'), false);
  assert.deepEqual(result.cancellations, [
    { expenseId: 'R1', released: 70, redFlushPending: 30 },
  ]);
  assert.equal(result.totals.released, 70);
  assert.equal(result.totals.redFlushPending, 30);
});

test('acceptance 2b: without the cancellation the new expense cannot be full', () => {
  const result = reserve({
    envelopes: [{ id: 'E1', category: 'travel', limit: 100 }],
    expenses: [
      { id: 'R1', category: 'travel', amount: 100 },
      { id: 'R2', category: 'travel', amount: 100 },
    ],
  });
  assert.equal(result.status, 'OK');
  const tiers = result.assignments.map((a) => a.tier);
  assert.ok(tiers.includes('DEFERRED'));
});

test('acceptance 3: paid amount beyond every envelope limit is UNSAT with conflicts', () => {
  const result = reserve({
    envelopes: [{ id: 'E1', category: 'travel', limit: 100 }],
    expenses: [{ id: 'R1', category: 'travel', amount: 200, paid: 120 }],
  });
  assert.equal(result.status, 'UNSAT');
  assert.equal(result.assignments.length, 0);
  assert.ok(result.conflicts.length > 0);
  assert.equal(result.conflicts[0].expenseId, 'R1');
  assert.equal(result.conflicts[0].envelopes[0].id, 'E1');
});

test('acceptance 3b: related paid expenses exceeding one shared envelope are UNSAT', () => {
  const result = reserve({
    envelopes: [{ id: 'E1', category: 'travel', limit: 100 }],
    expenses: [
      { id: 'R1', category: 'travel', amount: 60, paid: 60, group: 'G1' },
      { id: 'R2', category: 'travel', amount: 60, paid: 60, group: 'G1' },
    ],
  });
  assert.equal(result.status, 'UNSAT');
  assert.ok(result.conflicts.length > 0);
});

test('acceptance 4: exhausted backtrack budget yields PENDING, larger budget proves UNSAT', () => {
  const input = {
    envelopes: [
      { id: 'E1', category: 'travel', limit: 100 },
      { id: 'E2', category: 'travel', limit: 100 },
    ],
    expenses: [
      { id: 'R1', category: 'travel', amount: 100, paid: 60 },
      { id: 'R2', category: 'travel', amount: 100, paid: 60 },
      { id: 'R3', category: 'travel', amount: 100, paid: 60 },
    ],
  };
  const pending = reserve({ ...input, backtrackBudget: 0 });
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.assignments.length, 0);
  const proved = reserve(input);
  assert.equal(proved.status, 'UNSAT');
  assert.ok(proved.conflicts.length > 0);
});

test('validation: negative amount exits via InputError', () => {
  assert.throws(
    () => reserve({
      envelopes: [{ id: 'E1', category: 'travel', limit: 100 }],
      expenses: [{ id: 'R1', category: 'travel', amount: -5 }],
    }),
    (err) => err instanceof InputError && /negative/.test(err.message),
  );
});

test('validation: negative envelope limit is rejected', () => {
  assert.throws(
    () => reserve({
      envelopes: [{ id: 'E1', category: 'travel', limit: -1 }],
      expenses: [],
    }),
    InputError,
  );
});

test('validation: cancellation of an unknown expense is rejected', () => {
  assert.throws(
    () => reserve({
      envelopes: [{ id: 'E1', category: 'travel', limit: 100 }],
      expenses: [{ id: 'R1', category: 'travel', amount: 10 }],
      cancellations: [{ expenseId: 'NOPE' }],
    }),
    (err) => err instanceof InputError && /unknown expense: NOPE/.test(err.message),
  );
});

test('eighty tier reserves 80% and deferred keeps only the paid part', () => {
  const result = reserve({
    envelopes: [{ id: 'E1', category: 'travel', limit: 90 }],
    expenses: [{ id: 'R1', category: 'travel', amount: 100, paid: 10 }],
  });
  assert.equal(result.status, 'OK');
  const r1 = result.assignments[0];
  assert.equal(r1.tier, 'EIGHTY');
  assert.equal(r1.reserved, 80);
  const deferred = reserve({
    envelopes: [{ id: 'E1', category: 'travel', limit: 50 }],
    expenses: [{ id: 'R1', category: 'travel', amount: 100, paid: 50 }],
  });
  assert.equal(deferred.status, 'OK');
  assert.equal(deferred.assignments[0].tier, 'DEFERRED');
  assert.equal(deferred.assignments[0].reserved, 50);
});
