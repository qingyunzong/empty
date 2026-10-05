import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseProblem } from '../src/parse.js';
import { solveProblem } from '../src/solve.js';
import { checkSolution } from '../src/cert.js';
import type { ProblemInput, Solution } from '../src/types.js';

const INPUT = {
  nodes: ['s', 'a', 'b', 'c', 't'],
  edges: [
    { id: 'sa', from: 's', to: 'a', cost: 100 },
    { id: 'ab', from: 'a', to: 'b', cost: 100 },
    { id: 'bc', from: 'b', to: 'c', cost: 100 },
    { id: 'ca', from: 'c', to: 'a', cost: 1 },
    { id: 'ct', from: 'c', to: 't', cost: 100 },
  ],
  entries: ['s'],
  exits: ['t'],
} satisfies ProblemInput;

function solved(): { problem: ReturnType<typeof parseProblem>; sol: Solution } {
  const problem = parseProblem(INPUT);
  const sol = solveProblem(problem, { verify: true });
  assert.equal(sol.status, 'optimal');
  return { problem, sol };
}

test('checker accepts a genuine optimal solution', () => {
  const { problem, sol } = solved();
  const res = checkSolution(problem, sol);
  assert.deepEqual(res.errors, []);
  assert.equal(res.valid, true);
});

test('checker rejects a tampered (non-optimal) deletion set', () => {
  const { problem, sol } = solved();
  const bad: Solution = {
    ...sol,
    deletedEdges: [{ id: 'ab', from: 'a', to: 'b', cost: 100, group: null }],
    totalCost: 100,
  };
  const res = checkSolution(problem, bad);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /not optimal/.test(e)));
});

test('checker rejects deleting a locked edge', () => {
  const problem = parseProblem({
    nodes: ['a', 'b'],
    edges: [
      { id: 'ab', from: 'a', to: 'b', locked: true },
      { id: 'ba', from: 'b', to: 'a', cost: 2 },
    ],
  } satisfies ProblemInput);
  const fake: Solution = {
    status: 'optimal',
    deletedEdges: [{ id: 'ab', from: 'a', to: 'b', cost: 1, group: null }],
    totalCost: 1,
    topologicalOrder: ['a', 'b'],
    preservedPaths: [],
  };
  const res = checkSolution(problem, fake);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /locked/.test(e)));
});

test('checker rejects a broken path certificate', () => {
  const { problem, sol } = solved();
  const bad: Solution = {
    ...sol,
    preservedPaths: [{ from: 's', to: 't', path: ['s', 'a', 'c', 't'] }],
  };
  const res = checkSolution(problem, bad);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /deleted\/missing edge a -> c/.test(e)));
});

test('checker rejects a missing path certificate', () => {
  const { problem, sol } = solved();
  const bad: Solution = { ...sol, preservedPaths: [] };
  const res = checkSolution(problem, bad);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /missing path certificate/.test(e)));
});

test('checker rejects an invalid topological order', () => {
  const { problem, sol } = solved();
  const bad: Solution = { ...sol, topologicalOrder: [...sol.topologicalOrder!].reverse() };
  const res = checkSolution(problem, bad);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /topologicalOrder violates/.test(e)));
});

test('checker rejects a group-prerequisite violation', () => {
  const problem = parseProblem({
    nodes: ['a', 'b', 'c'],
    edges: [
      { id: 'ab', from: 'a', to: 'b', cost: 10 },
      { id: 'ba', from: 'b', to: 'a', cost: 1, group: 'plugin' },
      { id: 'cc', from: 'c', to: 'c', cost: 2, group: 'core' },
    ],
    groups: { plugin: { requires: ['core'] } },
  } satisfies ProblemInput);
  const fake: Solution = {
    status: 'optimal',
    deletedEdges: [{ id: 'ba', from: 'b', to: 'a', cost: 1, group: 'plugin' }],
    totalCost: 1,
    topologicalOrder: ['a', 'b', 'c'],
    preservedPaths: [],
  };
  const res = checkSolution(problem, fake);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /group prerequisite violated/.test(e)));
});

test('checker validates infeasible claims via re-enumeration', () => {
  const problem = parseProblem({
    nodes: ['a', 'b'],
    edges: [
      { id: 'ab', from: 'a', to: 'b', locked: true },
      { id: 'ba', from: 'b', to: 'a', locked: true },
    ],
  } satisfies ProblemInput);
  const sol = solveProblem(problem);
  assert.equal(sol.status, 'infeasible');
  const res = checkSolution(problem, sol);
  assert.equal(res.valid, true);

  // but a false infeasible claim on a solvable problem is rejected
  const solvable = parseProblem({
    nodes: ['a', 'b'],
    edges: [
      { id: 'ab', from: 'a', to: 'b' },
      { id: 'ba', from: 'b', to: 'a' },
    ],
  } satisfies ProblemInput);
  const lie: Solution = { status: 'infeasible', infeasible: { reason: 'nope' } };
  const res2 = checkSolution(solvable, lie);
  assert.equal(res2.valid, false);
});
