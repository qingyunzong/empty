import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Problem,
  bruteForceSolve,
  evaluateVector,
  normalize,
  solveTreeDp,
} from '../src/index';
import { mulberry32, randomProblem } from './helpers';

test('handcrafted non-concave instance: exact value, vector, node aggregates', () => {
  // Payoff table of "a" has increments 1,3,0,-2 (not concave).
  const problem: Problem = {
    budget: 6,
    root: {
      id: 'R',
      min: 0,
      max: 6,
      children: [
        { id: 'A', min: 0, max: 4, leaf: { payoff: [0, 1, 4, 4, 2] } },
        {
          id: 'B',
          min: 1,
          max: 5,
          children: [
            { id: 'b', min: 0, max: 3, leaf: { payoff: [0, 2, 2, 5] } },
            { id: 'c', min: 0, max: 3, leaf: { payoff: [0, 0, 3, 3] } },
          ],
        },
      ],
    },
  };
  const sol = solveTreeDp(problem);
  assert.equal(sol.feasible, true);
  assert.equal(sol.payoff, 9);
  assert.deepEqual(sol.vector, [1, 3, 2]);
  assert.deepEqual(sol.aggregates, { R: 6, A: 1, B: 5, b: 3, c: 2 });
});

test('tie-break: lexicographically smallest vector among optima', () => {
  const problem: Problem = {
    budget: 4,
    root: {
      id: 'R',
      children: [
        { id: 'p', leaf: { payoff: [0, 1, 2, 3, 4] } },
        { id: 'q', leaf: { payoff: [0, 1, 2, 3, 4] } },
      ],
    },
  };
  const sol = solveTreeDp(problem);
  assert.equal(sol.payoff, 4);
  assert.deepEqual(sol.vector, [0, 4]);
});

test('startup fee is deducted only when the leaf is funded', () => {
  const problem: Problem = {
    budget: 1,
    root: {
      id: 'R',
      children: [
        { id: 'a', leaf: { payoff: [0, 10], startupFee: 8 } },
        { id: 'b', leaf: { payoff: [0, 5] } },
      ],
    },
  };
  const sol = solveTreeDp(problem);
  assert.equal(sol.payoff, 5);
  assert.deepEqual(sol.vector, [0, 1]);
});

test('infeasible when a leaf lower bound exceeds its payoff table', () => {
  const problem: Problem = {
    budget: 10,
    root: { id: 'R', children: [{ id: 'a', min: 5, leaf: { payoff: [0, 1, 2] } }] },
  };
  const sol = solveTreeDp(problem);
  assert.equal(sol.feasible, false);
  assert.equal(sol.payoff, null);
  assert.equal(sol.vector, null);
  assert.equal(sol.aggregates, null);
});

test('budget above 80 is rejected', () => {
  const problem: Problem = {
    budget: 81,
    root: { id: 'R', leaf: { payoff: [0, 1] } },
  };
  assert.throws(() => solveTreeDp(problem), /budget/);
});

test('tree DP rejects problems with cross constraints', () => {
  const problem: Problem = {
    budget: 4,
    root: {
      id: 'R',
      children: [
        { id: 'a', leaf: { payoff: [0, 1] } },
        { id: 'b', leaf: { payoff: [0, 1] } },
      ],
    },
    constraints: [{ a: 0, b: 1, maxDiff: 1 }],
  };
  assert.throws(() => solveTreeDp(problem), /cross constraints/);
});

test('randomized: tree DP matches leaf-vector enumeration', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = mulberry32(seed);
    const problem = randomProblem(rand, { budget: 8, withFees: true });
    const dp = solveTreeDp(problem);
    const brute = bruteForceSolve(problem);
    assert.equal(dp.feasible, brute.feasible, `seed ${seed} feasibility`);
    assert.equal(dp.payoff, brute.payoff, `seed ${seed} payoff`);
    assert.deepEqual(dp.vector, brute.vector, `seed ${seed} vector`);
    if (dp.feasible) {
      const norm = normalize(problem);
      const evaluation = evaluateVector(norm, dp.vector!);
      assert.equal(evaluation.feasible, true, `seed ${seed}: ${evaluation.violations}`);
      assert.deepEqual(dp.aggregates, evaluation.aggregates, `seed ${seed} aggregates`);
    }
  }
});
