'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProblem } = require('../src/model');
const { solve } = require('../src/solve');
const { minimalInfeasibleSubset } = require('../src/certificate');

function isFeasibleJSON(json) {
  return solve(normalizeProblem(json)).feasible;
}

function assertIrreducible(certificate) {
  assert.equal(isFeasibleJSON(certificate), false, 'certificate itself must be infeasible');
  for (const task of certificate.tasks) {
    const trial = structuredClone(certificate);
    trial.tasks = trial.tasks.filter((t) => t.id !== task.id);
    trial.precedence = trial.precedence.filter(([a, b]) => a !== task.id && b !== task.id);
    assert.equal(isFeasibleJSON(trial), true, `removing task ${task.id} must restore feasibility`);
  }
  for (const edge of certificate.precedence) {
    const trial = structuredClone(certificate);
    trial.precedence = trial.precedence.filter((e) => !(e[0] === edge[0] && e[1] === edge[1]));
    assert.equal(isFeasibleJSON(trial), true, `removing precedence ${edge} must restore feasibility`);
  }
  for (const [line, slots] of Object.entries(certificate.capacity)) {
    for (const slot of Object.keys(slots)) {
      const trial = structuredClone(certificate);
      delete trial.capacity[line][slot];
      assert.equal(isFeasibleJSON(trial), true, `removing capacity ${line}:${slot} must restore feasibility`);
    }
  }
}

test('scenario 2: due conflict certificate is exactly the conflicting task pair', () => {
  const certificate = minimalInfeasibleSubset({
    tasks: [
      { id: 'a', line: 'L1', duration: 2, release: 0, due: 2 },
      { id: 'b', line: 'L1', duration: 2, release: 0, due: 2 },
      { id: 'c', line: 'L2', duration: 1, release: null, due: null },
      { id: 'd', line: 'L2', duration: 1, release: null, due: null },
    ],
    precedence: [['c', 'd']],
    capacity: {},
  });
  assert.equal(certificate.kind, 'minimalInfeasibleSubset');
  assert.deepEqual(
    certificate.tasks.map((t) => t.id).sort(),
    ['a', 'b'],
    'unrelated tasks c, d and their precedence must be filtered out',
  );
  assert.deepEqual(certificate.precedence, []);
  assertIrreducible(certificate);
});

test('certificate includes capacity overrides when they cause infeasibility', () => {
  const certificate = minimalInfeasibleSubset({
    tasks: [{ id: 'a', line: 'L1', duration: 1, release: 0, due: 2 }],
    precedence: [],
    capacity: { L1: { '0': 0, '1': 0 } },
  });
  assert.deepEqual(certificate.tasks.map((t) => t.id), ['a']);
  assert.deepEqual(certificate.capacity, { L1: { '0': 0, '1': 0 } });
  assertIrreducible(certificate);
});

test('certificate includes precedence when the cycle is the cause', () => {
  const certificate = minimalInfeasibleSubset({
    tasks: [
      { id: 'a', line: 'L1', duration: 1, release: null, due: null },
      { id: 'b', line: 'L1', duration: 1, release: null, due: null },
      { id: 'c', line: 'L2', duration: 1, release: null, due: null },
    ],
    precedence: [['a', 'b'], ['b', 'a']],
    capacity: {},
  });
  assert.deepEqual(certificate.tasks.map((t) => t.id).sort(), ['a', 'b']);
  assert.equal(certificate.precedence.length, 2);
  assertIrreducible(certificate);
});
