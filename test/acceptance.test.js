'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { candidates, award, applyChange } = require('../src/lib');

// Scenario 1: two machines fully qualified and tied -> lexicographic choice.
test('scenario 1: tied qualified machines resolve lexicographically', () => {
  const data = {
    orders: [{ order: 'O1', process: 'P1' }],
    machines: [
      { machine: 'M1', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M2', process: 'P1', cert_expiry: '2027-01-01' },
    ],
    costs: [
      { machine: 'M1', shift_cost: 10 },
      { machine: 'M2', shift_cost: 10 },
    ],
    budget: 100,
  };
  const result = award(data, 'O1');
  assert.equal(result.status, 'awarded');
  assert.deepEqual(result.machines, ['M1']);
  assert.equal(result.total_cost, 10);
});

test('scenario 1b: tied multi-machine combos resolve lexicographically', () => {
  const data = {
    orders: [
      { order: 'O1', process: 'P1' },
      { order: 'O1', process: 'P2' },
    ],
    machines: [
      { machine: 'A', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'B', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'C', process: 'P2', cert_expiry: '2027-01-01' },
      { machine: 'D', process: 'P2', cert_expiry: '2027-01-01' },
    ],
    costs: [
      { machine: 'A', shift_cost: 5 },
      { machine: 'B', shift_cost: 5 },
      { machine: 'C', shift_cost: 5 },
      { machine: 'D', shift_cost: 5 },
    ],
    budget: 100,
  };
  const result = award(data, 'O1');
  // {A,C}, {A,D}, {B,C}, {B,D}: all 2 machines at cost 10 -> lexicographic min.
  assert.deepEqual(result.machines, ['A', 'C']);
});

// Scenario 2: a null certificate excludes every combination using that machine.
test('scenario 2: null cert excludes the machine from all combinations', () => {
  const data = {
    orders: [{ order: 'O1', process: 'P1' }],
    machines: [
      { machine: 'M1', process: 'P1', cert_expiry: null }, // cheapest but no valid cert
      { machine: 'M2', process: 'P1', cert_expiry: '2027-01-01' },
    ],
    costs: [
      { machine: 'M1', shift_cost: 1 },
      { machine: 'M2', shift_cost: 9 },
    ],
    budget: 100,
  };
  const cand = candidates(data, 'O1');
  assert.deepEqual(cand.candidates.map((c) => c.machine), ['M2']);
  const result = award(data, 'O1');
  assert.equal(result.status, 'awarded');
  assert.deepEqual(result.machines, ['M2']);
  assert.equal(result.total_cost, 9);
});

test('scenario 2b: null cert on the only capable machine -> infeasible, not pending', () => {
  const data = {
    orders: [
      { order: 'O1', process: 'P1' },
      { order: 'O1', process: 'P2' },
    ],
    machines: [
      { machine: 'M1', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M2', process: 'P2', cert_expiry: null },
    ],
    costs: [
      { machine: 'M1', shift_cost: 5 },
      { machine: 'M2', shift_cost: 5 },
    ],
    budget: 100,
  };
  const result = award(data, 'O1');
  assert.equal(result.status, 'infeasible');
  assert.deepEqual(result.certificate, { type: 'missing_capability', processes: ['P2'] });
});

// Scenario 3: budget cut invalidates the original plan and switches to the backup.
test('scenario 3: budget decrease withdraws original award and switches to backup', () => {
  const data = {
    orders: [
      { order: 'O1', process: 'P1' },
      { order: 'O1', process: 'P2' },
    ],
    machines: [
      { machine: 'M1', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M1', process: 'P2', cert_expiry: '2027-01-01' },
      { machine: 'M2', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M3', process: 'P2', cert_expiry: '2027-01-01' },
    ],
    costs: [
      { machine: 'M1', shift_cost: 8 },
      { machine: 'M2', shift_cost: 3 },
      { machine: 'M3', shift_cost: 4 },
    ],
    budget: 8,
  };
  // Original plan: {M1} (1 machine, cost 8) beats {M2,M3} (2 machines, cost 7).
  const before = award(data, 'O1');
  assert.equal(before.status, 'awarded');
  assert.deepEqual(before.machines, ['M1']);
  assert.equal(before.total_cost, 8);

  // Budget cut to 7: {M1} is over budget, backup {M2,M3} (cost 7) takes over.
  const result = applyChange(data, 'O1', { type: 'budget', budget: 7 });
  assert.deepEqual(result.withdrawn.machines, ['M1']);
  assert.deepEqual(result.diff, { added: ['M2', 'M3'], removed: ['M1'] });
  assert.equal(result.reassignment.status, 'awarded');
  assert.deepEqual(result.reassignment.machines, ['M2', 'M3']);
  assert.equal(result.reassignment.total_cost, 7);
  assert.equal(result.reassignment.budget, 7);
  assert.deepEqual(result.reassignment.allocation, [
    { process: 'P1', machine: 'M2' },
    { process: 'P2', machine: 'M3' },
  ]);
});

test('scenario 3b: budget cut below every combination -> infeasible with budget certificate', () => {
  const data = {
    orders: [
      { order: 'O1', process: 'P1' },
      { order: 'O1', process: 'P2' },
    ],
    machines: [
      { machine: 'M1', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M1', process: 'P2', cert_expiry: '2027-01-01' },
      { machine: 'M2', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M3', process: 'P2', cert_expiry: '2027-01-01' },
    ],
    costs: [
      { machine: 'M1', shift_cost: 8 },
      { machine: 'M2', shift_cost: 3 },
      { machine: 'M3', shift_cost: 4 },
    ],
    budget: 8,
  };
  const result = applyChange(data, 'O1', { type: 'budget', budget: 6 });
  assert.deepEqual(result.withdrawn.machines, ['M1']);
  assert.deepEqual(result.diff, { added: [], removed: ['M1'] });
  assert.equal(result.reassignment.status, 'infeasible');
  assert.deepEqual(result.reassignment.certificate, {
    type: 'budget',
    budget: 6,
    min_cost: 7,
    deficit: 1,
    cheapest_combination: ['M2', 'M3'],
  });
});

test('cert revocation event withdraws and re-assigns', () => {
  const data = {
    orders: [{ order: 'O1', process: 'P1' }],
    machines: [
      { machine: 'M1', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M2', process: 'P1', cert_expiry: '2027-01-01' },
    ],
    costs: [
      { machine: 'M1', shift_cost: 4 },
      { machine: 'M2', shift_cost: 6 },
    ],
    budget: 10,
  };
  const result = applyChange(data, 'O1', { type: 'revoke-cert', machine: 'M1' });
  assert.deepEqual(result.withdrawn.machines, ['M1']);
  assert.deepEqual(result.diff, { added: ['M2'], removed: ['M1'] });
  assert.equal(result.reassignment.status, 'awarded');
  assert.deepEqual(result.reassignment.machines, ['M2']);
});

test('revoking the only capable cert yields infeasible with minimal certificate', () => {
  const data = {
    orders: [{ order: 'O1', process: 'P1' }],
    machines: [{ machine: 'M1', process: 'P1', cert_expiry: '2027-01-01' }],
    costs: [{ machine: 'M1', shift_cost: 4 }],
    budget: 10,
  };
  const result = applyChange(data, 'O1', { type: 'revoke-cert', machine: 'M1', process: 'P1' });
  assert.equal(result.reassignment.status, 'infeasible');
  assert.deepEqual(result.reassignment.certificate, {
    type: 'missing_capability',
    processes: ['P1'],
  });
  assert.deepEqual(result.diff, { added: [], removed: ['M1'] });
});

test('relational division: candidates only include valid certs on required processes', () => {
  const data = {
    orders: [{ order: 'O1', process: 'P1' }],
    machines: [
      { machine: 'M1', process: 'P1', cert_expiry: '2027-01-01' },
      { machine: 'M1', process: 'P9', cert_expiry: '2027-01-01' }, // not required
      { machine: 'M2', process: 'P9', cert_expiry: '2027-01-01' }, // no required process
      { machine: 'M3', process: 'P1', cert_expiry: null },
    ],
    costs: [
      { machine: 'M1', shift_cost: 1 },
      { machine: 'M2', shift_cost: 1 },
      { machine: 'M3', shift_cost: 1 },
    ],
    budget: 10,
  };
  const cand = candidates(data, 'O1');
  assert.deepEqual(cand.required, ['P1']);
  assert.deepEqual(cand.candidates, [{ machine: 'M1', processes: ['P1'] }]);
});
