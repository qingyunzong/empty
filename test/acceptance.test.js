'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { solve } = require('../src/solver');

function dispositionOf(output, id) {
  return output.dispositions.find((d) => d.instruction === id);
}

// Acceptance 1: three accounts, feasible only via bilateral netting.
test('three-account feasible netting', () => {
  const output = solve({
    accounts: [
      { id: 'A', limit: 50 },
      { id: 'B', limit: 50 },
      { id: 'C', limit: 50 },
    ],
    instructions: [
      { id: 'I1', from: 'A', to: 'B', amount: 100, mandatory: false },
      { id: 'I2', from: 'B', to: 'A', amount: 90, mandatory: false },
      { id: 'I3', from: 'B', to: 'C', amount: 80, mandatory: false },
      { id: 'I4', from: 'C', to: 'B', amount: 70, mandatory: false },
      { id: 'I5', from: 'C', to: 'A', amount: 60, mandatory: false },
      { id: 'I6', from: 'A', to: 'C', amount: 50, mandatory: false },
    ],
    revocations: [],
    budget: 1000000,
    previous: null,
  });
  assert.equal(output.status, 'SETTLED');
  for (const entry of output.dispositions) {
    assert.equal(entry.disposition, 'NET', `${entry.instruction} should be netted`);
  }
  assert.deepEqual(output.freezes, { A: 10, B: 10, C: 10 });
  assert.equal(output.certificate.freezes.A, 10);
  assert.equal(typeof output.certificate.backtracks, 'number');
  assert.ok(output.certificate.backtracks >= 0);
  assert.equal(output.certificate.conflict, null);
  assert.ok(Array.isArray(output.certificate.decisions));
  assert.ok(output.certificate.domainsAfterPropagation.I1.includes('NET'));
});

// Acceptance 2: a revocation forces an incremental correction of the prior plan.
test('revocation triggers incremental correction of the previous plan', () => {
  const base = {
    accounts: [
      { id: 'A', limit: 100 },
      { id: 'B', limit: 100 },
    ],
    instructions: [
      { id: 'I1', from: 'A', to: 'B', amount: 80, mandatory: false },
      { id: 'I2', from: 'A', to: 'B', amount: 50, mandatory: false },
    ],
    revocations: [],
    budget: 1000000,
    previous: null,
  };
  const plan1 = solve(base);
  assert.equal(plan1.status, 'SETTLED');
  assert.equal(dispositionOf(plan1, 'I1').disposition, 'FULL');
  assert.equal(dispositionOf(plan1, 'I2').disposition, 'PEND');
  assert.deepEqual(dispositionOf(plan1, 'I2').reasons.map((r) => r.code), [
    'INSUFFICIENT_LIMIT',
    'NO_NETTING_PARTNER',
  ]);
  assert.equal(plan1.freezes.A, 80);

  const plan2 = solve({
    ...base,
    revocations: [{ seq: 1, instruction: 'I1' }],
    previous: {
      dispositions: Object.fromEntries(
        plan1.dispositions.map((d) => [d.instruction, d.disposition]),
      ),
    },
  });
  assert.equal(plan2.status, 'SETTLED');
  const revoked = dispositionOf(plan2, 'I1');
  assert.equal(revoked.disposition, 'PEND');
  assert.equal(revoked.reasons[0].code, 'REVOKED');
  assert.equal(revoked.reasons[0].revocationSeq, 1);
  assert.equal(dispositionOf(plan2, 'I2').disposition, 'FULL');
  assert.equal(plan2.freezes.A, 50);
  assert.deepEqual(plan2.certificate.revocations, [
    { seq: 1, instruction: 'I1', released: 80 },
  ]);
  assert.deepEqual(plan2.certificate.changes, [
    { instruction: 'I1', from: 'FULL', to: 'PEND' },
    { instruction: 'I2', from: 'PEND', to: 'FULL' },
  ]);
});

// Revocations are released newest-first (reverse time order).
test('revocations release original freezes in reverse time order', () => {
  const output = solve({
    accounts: [
      { id: 'A', limit: 100 },
      { id: 'B', limit: 100 },
    ],
    instructions: [
      { id: 'I1', from: 'A', to: 'B', amount: 30, mandatory: false },
      { id: 'I2', from: 'A', to: 'B', amount: 40, mandatory: false },
      { id: 'I3', from: 'A', to: 'B', amount: 20, mandatory: false },
    ],
    revocations: [
      { seq: 1, instruction: 'I1' },
      { seq: 2, instruction: 'I3' },
    ],
    budget: 1000000,
    previous: { dispositions: { I1: 'FULL', I2: 'FULL', I3: 'FULL' } },
  });
  assert.equal(output.status, 'SETTLED');
  assert.deepEqual(
    output.certificate.revocations.map((r) => r.seq),
    [2, 1],
  );
  assert.deepEqual(output.certificate.revocations, [
    { seq: 2, instruction: 'I3', released: 20 },
    { seq: 1, instruction: 'I1', released: 30 },
  ]);
  assert.equal(output.freezes.A, 40);
});

// Acceptance 3: a tiny backtrack budget yields PENDING (never UNSAT) plus a conflict.
test('small budget returns PENDING with conflict, not UNSAT', () => {
  const problem = {
    accounts: [
      { id: 'A', limit: 50 },
      { id: 'B', limit: 200 },
    ],
    instructions: [
      { id: 'I1', from: 'A', to: 'B', amount: 100, mandatory: true },
      { id: 'I2', from: 'B', to: 'A', amount: 60, mandatory: false },
    ],
    revocations: [],
    previous: null,
  };
  const pending = solve({ ...problem, budget: 0 });
  assert.equal(pending.status, 'PENDING');
  assert.notEqual(pending.status, 'UNSAT');
  assert.equal(pending.dispositions, null);
  assert.equal(pending.certificate.backtracks, 1);
  const conflict = pending.certificate.conflict;
  assert.equal(conflict.kind, 'EMPTY_DOMAIN');
  assert.equal(conflict.minimal, true);
  assert.deepEqual(conflict.instructions, ['I1']);

  const settled = solve({ ...problem, budget: 100 });
  assert.equal(settled.status, 'SETTLED');
  assert.equal(dispositionOf(settled, 'I1').disposition, 'NET');
  assert.equal(dispositionOf(settled, 'I2').disposition, 'NET');
  assert.deepEqual(settled.freezes, { A: 40, B: 0 });
});

// UNSAT is only reported after exhaustive search within budget.
test('genuine UNSAT: mandatory instruction exceeds its account limit', () => {
  const output = solve({
    accounts: [
      { id: 'A', limit: 50 },
      { id: 'B', limit: 50 },
    ],
    instructions: [{ id: 'I1', from: 'A', to: 'B', amount: 100, mandatory: true }],
    revocations: [],
    budget: 1000000,
    previous: null,
  });
  assert.equal(output.status, 'UNSAT');
  assert.equal(output.certificate.conflict.kind, 'LIMIT_EXCEEDED');
  assert.deepEqual(output.certificate.conflict.instructions, ['I1']);
});

test('genuine UNSAT: revoked mandatory instruction has no legal disposition', () => {
  const output = solve({
    accounts: [
      { id: 'A', limit: 100 },
      { id: 'B', limit: 100 },
    ],
    instructions: [{ id: 'I1', from: 'A', to: 'B', amount: 10, mandatory: true }],
    revocations: [{ seq: 7, instruction: 'I1' }],
    budget: 1000000,
    previous: null,
  });
  assert.equal(output.status, 'UNSAT');
  const conflict = output.certificate.conflict;
  assert.equal(conflict.kind, 'REVOKED_MANDATORY');
  assert.equal(conflict.revocationSeq, 7);
  assert.deepEqual(conflict.instructions, ['I1']);
});
