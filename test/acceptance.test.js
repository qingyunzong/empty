'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { processInput } = require('../lib/plan');

test('acceptance 1: related documents are reserved in the same package', () => {
  const out = processInput({
    packages: [
      { id: 'P1', limits: { travel: 700 } },
      { id: 'P2', limits: { travel: 1200 } },
    ],
    reimbursements: [
      { id: 'R1', category: 'travel', amount: 600, group: 'G' },
      { id: 'R2', category: 'travel', amount: 500, group: 'G' },
    ],
  });
  assert.equal(out.status, 'OK');
  assert.equal(out.assignments.length, 2);
  // 600 + 500 = 1100 fits only in P2; the group must not be split.
  assert.equal(out.assignments[0].package, 'P2');
  assert.equal(out.assignments[1].package, 'P2');
  assert.equal(out.assignments[0].tier, 'full');
  assert.equal(out.assignments[1].tier, 'full');
});

test('acceptance 2: capacity freed by a cancellation admits a new document', () => {
  const out = processInput({
    packages: [{ id: 'P1', limits: { travel: 1000 } }],
    reimbursements: [
      { id: 'R1', category: 'travel', amount: 900 },
      { id: 'R2', category: 'travel', amount: 900 },
    ],
    cancellations: [{ id: 'C1', target: 'R1' }],
  });
  assert.equal(out.status, 'OK');
  assert.deepEqual(out.releases, [{ cancellation: 'C1', target: 'R1', released: 900 }]);
  assert.deepEqual(out.redFlushPending, []);
  const r2 = out.assignments.find((a) => a.id === 'R2');
  assert.equal(r2.tier, 'full');
  assert.equal(r2.reserved, 900);
  assert.equal(out.assignments.some((a) => a.id === 'R1'), false);
  assert.equal(out.packageUsage[0].categories.travel.reserved, 900);
});

test('cancellation keeps the paid part as red-flush pending hold', () => {
  const out = processInput({
    packages: [{ id: 'P1', limits: { travel: 1000 } }],
    reimbursements: [
      { id: 'R1', category: 'travel', amount: 500, paid: 200 },
      { id: 'R2', category: 'travel', amount: 900 },
    ],
    cancellations: [{ id: 'C1', target: 'R1', package: 'P1' }],
  });
  assert.equal(out.status, 'OK');
  assert.deepEqual(out.releases, [{ cancellation: 'C1', target: 'R1', released: 300 }]);
  assert.deepEqual(out.redFlushPending, [{ cancellation: 'C1', target: 'R1', amount: 200 }]);
  // 200 is still held, so only 800 remains: R2 drops to the eighty tier.
  const r2 = out.assignments.find((a) => a.id === 'R2');
  assert.equal(r2.tier, 'eighty');
  assert.equal(r2.reserved, 720);
  const travel = out.packageUsage[0].categories.travel;
  assert.equal(travel.reserved, 720);
  assert.equal(travel.redFlushPending, 200);
  assert.equal(travel.limit, 1000);
});

test('acceptance 3: exceeding every package with no deferral option is UNSAT', () => {
  const out = processInput({
    packages: [{ id: 'P1', limits: { travel: 100 } }],
    reimbursements: [{ id: 'R1', category: 'travel', amount: 500, tiers: ['full'] }],
  });
  assert.equal(out.status, 'UNSAT');
  assert.deepEqual(out.assignments, []);
  assert.ok(out.conflicts.length > 0);
  const summary = out.conflicts.find((c) => c.type === 'category-capacity');
  assert.deepEqual(summary, { type: 'category-capacity', category: 'travel', required: 500, capacity: 100 });
});

test('acceptance 4: a tiny backtrack budget yields PENDING, a larger one solves', () => {
  const input = {
    packages: [{ id: 'P1', limits: { travel: 100 } }],
    reimbursements: [
      { id: 'R1', category: 'travel', amount: 80, tiers: ['full', 'eighty'] },
      { id: 'R2', category: 'travel', amount: 30, tiers: ['full'] },
    ],
  };
  const pending = processInput({ ...input, backtrackBudget: 0 });
  assert.equal(pending.status, 'PENDING');
  assert.deepEqual(pending.assignments, []);

  const solved = processInput({ ...input, backtrackBudget: 10 });
  assert.equal(solved.status, 'OK');
  // R1 must backtrack from full to eighty so R2 fits: 64 + 30 <= 100.
  assert.equal(solved.assignments.find((a) => a.id === 'R1').tier, 'eighty');
  assert.equal(solved.assignments.find((a) => a.id === 'R2').tier, 'full');
});

test('eighty tier reserves 80% rounded to cents', () => {
  const out = processInput({
    packages: [{ id: 'P1', limits: { meals: 100 } }],
    reimbursements: [{ id: 'R1', category: 'meals', amount: 100.05, tiers: ['eighty'] }],
  });
  assert.equal(out.status, 'OK');
  assert.equal(out.assignments[0].reserved, 80.04);
});
