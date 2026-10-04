'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { solve, computeFreezes } = require('../src/solver');
const {
  assignmentValid,
  enumerateValid,
  randomProblem,
  mulberry32,
} = require('./helpers');

// Cross-check the solver against full enumeration of every disposition
// assignment on small problems (<= 3 accounts, <= 5 instructions).
test('solver agrees with exhaustive enumeration on random small problems', () => {
  const rng = mulberry32(20261004);
  const cases = 120;
  for (let k = 0; k < cases; k += 1) {
    const problem = randomProblem(rng);
    const output = solve(problem);
    const valid = enumerateValid(problem);
    assert.notEqual(
      output.status,
      'PENDING',
      `case ${k}: generous budget must never yield PENDING`,
    );
    assert.equal(
      output.status === 'SETTLED',
      valid.length > 0,
      `case ${k}: feasibility mismatch vs enumeration (${JSON.stringify(problem)})`,
    );
    if (output.status === 'SETTLED') {
      const assignment = problem.instructions.map(
        (instruction) =>
          output.dispositions.find((d) => d.instruction === instruction.id).disposition,
      );
      assert.ok(
        assignmentValid(problem, assignment),
        `case ${k}: solver assignment must satisfy every constraint`,
      );
      const freezes = computeFreezes(problem.accounts, problem.instructions, assignment);
      for (const account of problem.accounts) {
        assert.equal(output.freezes[account.id], freezes.get(account.id));
        assert.ok(freezes.get(account.id) <= account.limit + 1e-9);
      }
      for (const entry of output.dispositions) {
        if (entry.disposition === 'PEND') {
          assert.ok(entry.reasons.length > 0, 'pending instructions must list reasons');
        }
      }
    } else {
      assert.ok(output.certificate.conflict, `case ${k}: UNSAT must carry a conflict`);
      assert.ok(output.certificate.conflict.instructions.length > 0);
    }
    assert.equal(typeof output.certificate.backtracks, 'number');
    assert.ok(Array.isArray(output.certificate.decisions));
    assert.ok(Array.isArray(output.certificate.revocations));
  }
});

// Deterministic handcrafted corner cases checked against enumeration too.
test('handcrafted corner cases agree with enumeration', () => {
  const problems = [
    {
      accounts: [{ id: 'A', limit: 0 }, { id: 'B', limit: 0 }],
      instructions: [{ id: 'I1', from: 'A', to: 'B', amount: 10, mandatory: true }],
      revocations: [],
      budget: 1000000,
      previous: null,
    },
    {
      accounts: [{ id: 'A', limit: 5 }, { id: 'B', limit: 5 }],
      instructions: [
        { id: 'I1', from: 'A', to: 'B', amount: 10, mandatory: true },
        { id: 'I2', from: 'B', to: 'A', amount: 10, mandatory: true },
      ],
      revocations: [],
      budget: 1000000,
      previous: null,
    },
    {
      accounts: [{ id: 'A', limit: 100 }, { id: 'B', limit: 100 }],
      instructions: [
        { id: 'I1', from: 'A', to: 'B', amount: 10, mandatory: false },
        { id: 'I2', from: 'A', to: 'B', amount: 20, mandatory: false },
      ],
      revocations: [
        { seq: 1, instruction: 'I1' },
        { seq: 2, instruction: 'I2' },
      ],
      budget: 1000000,
      previous: null,
    },
  ];
  for (const [k, problem] of problems.entries()) {
    const output = solve(problem);
    const valid = enumerateValid(problem);
    assert.equal(output.status === 'SETTLED', valid.length > 0, `corner case ${k}`);
  }
  // The fully netted mandatory pair freezes nothing and settles.
  const netted = solve(problems[1]);
  assert.equal(netted.status, 'SETTLED');
  assert.deepEqual(netted.freezes, { A: 0, B: 0 });
});
