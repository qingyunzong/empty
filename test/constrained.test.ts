import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConstrainedSolver,
  Problem,
  bruteForceSolve,
  evaluateVector,
  normalize,
  solveTreeDp,
} from '../src/index';
import { mulberry32, randomProblem } from './helpers';

test('cross-subtree constraint binds and changes the optimum', () => {
  const root = {
    id: 'R',
    children: [
      { id: 'a', leaf: { payoff: [0, 0, 0, 10] } },
      { id: 'b', leaf: { payoff: [0, 10] } },
    ],
  };
  const unconstrained = solveTreeDp({ budget: 4, root });
  assert.equal(unconstrained.payoff, 20);
  assert.deepEqual(unconstrained.vector, [3, 1]);

  const problem: Problem = {
    budget: 4,
    root,
    constraints: [{ a: 0, b: 1, maxDiff: 1 }],
  };
  const result = new ConstrainedSolver(problem).run();
  assert.equal(result.status, 'optimal');
  assert.equal(result.optimal, true);
  assert.equal(result.payoff, 10);
  assert.deepEqual(result.vector, [0, 1]);
  assert.deepEqual(result.aggregates, { R: 1, a: 0, b: 1 });

  const cert = result.certificate!;
  assert.equal(cert.constraints.length, 1);
  const c0 = cert.constraints[0];
  assert.equal(c0.aId, 'a');
  assert.equal(c0.bId, 'b');
  assert.equal(c0.xA, 0);
  assert.equal(c0.xB, 1);
  assert.equal(c0.diff, 1);
  assert.equal(c0.maxDiff, 1);
  assert.equal(c0.satisfied, true);
});

test('startup fee can flip the funding decision', () => {
  const problem: Problem = {
    budget: 2,
    root: {
      id: 'R',
      children: [
        { id: 'a', leaf: { payoff: [0, 10, 11], startupFee: 9 } },
        { id: 'b', leaf: { payoff: [0, 3, 4] } },
      ],
    },
    constraints: [],
  };
  const result = new ConstrainedSolver(problem).run();
  // a: gain(1)=1, gain(2)=2; b: gain(1)=3, gain(2)=4 -> fund b only.
  assert.equal(result.status, 'optimal');
  assert.equal(result.payoff, 4);
  assert.deepEqual(result.vector, [0, 2]);
});

test('work budget: unclosed run is never labeled optimal, then resumes to optimum', () => {
  const problem: Problem = {
    budget: 2,
    root: {
      id: 'R',
      children: [
        { id: 'a', leaf: { payoff: [0, 1, 2] } },
        { id: 'b', leaf: { payoff: [0, 1, 2] } },
      ],
    },
    constraints: [{ a: 0, b: 1, maxDiff: 2 }],
  };
  const solver = new ConstrainedSolver(problem);

  const partial = solver.run(3);
  assert.equal(partial.closed, false);
  assert.equal(partial.status, 'unclosed');
  assert.equal(partial.optimal, false, 'unclosed result must not be labeled optimal');
  assert.notEqual(partial.vector, null, 'incumbent exists but is not optimal');

  const resumed = solver.run(Infinity);
  assert.equal(resumed.closed, true);
  assert.equal(resumed.status, 'optimal');
  assert.equal(resumed.optimal, true);
  assert.equal(resumed.payoff, 2);
  assert.deepEqual(resumed.vector, [0, 2]);
  assert.ok(resumed.stats.stepsUsed > partial.stats.stepsUsed, 'work budget is cumulative');

  const oneShot = new ConstrainedSolver(problem).run();
  assert.equal(oneShot.payoff, resumed.payoff);
  assert.deepEqual(oneShot.vector, resumed.vector);
});

test('infeasible under cross constraints closes as "infeasible"', () => {
  const problem: Problem = {
    budget: 4,
    root: {
      id: 'R',
      children: [
        { id: 'a', min: 3, leaf: { payoff: [0, 0, 0, 1] } },
        { id: 'b', max: 1, leaf: { payoff: [0, 1] } },
      ],
    },
    constraints: [{ a: 0, b: 1, maxDiff: 1 }],
  };
  const result = new ConstrainedSolver(problem).run();
  assert.equal(result.closed, true);
  assert.equal(result.status, 'infeasible');
  assert.equal(result.optimal, false);
  assert.equal(result.vector, null);
});

test('more than ten cross constraints are rejected', () => {
  const children = [];
  for (let i = 0; i < 6; i++) children.push({ id: `L${i}`, leaf: { payoff: [0, 1, 2] } });
  const constraints = [];
  let count = 0;
  for (let a = 0; a < 6 && count < 11; a++) {
    for (let b = a + 1; b < 6 && count < 11; b++) {
      constraints.push({ a, b, maxDiff: 1 });
      count++;
    }
  }
  const problem: Problem = { budget: 6, root: { id: 'R', children }, constraints };
  assert.throws(() => new ConstrainedSolver(problem), /at most 10/);
});

test('randomized: branch-and-bound matches leaf-vector enumeration', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = mulberry32(1000 + seed);
    const problem = randomProblem(rand, {
      budget: 6,
      maxDepth: 2,
      withFees: true,
      withConstraints: true,
      maxConstraints: 4,
    });
    const result = new ConstrainedSolver(problem).run();
    const brute = bruteForceSolve(problem);
    assert.equal(result.closed, true, `seed ${seed}`);
    assert.equal(result.payoff, brute.payoff, `seed ${seed} payoff`);
    assert.deepEqual(result.vector, brute.vector, `seed ${seed} vector`);
    if (result.vector !== null) {
      const norm = normalize(problem);
      const evaluation = evaluateVector(norm, result.vector);
      assert.equal(evaluation.feasible, true, `seed ${seed}: ${evaluation.violations}`);
      for (const cert of result.certificate!.constraints) {
        assert.equal(cert.satisfied, true, `seed ${seed} certificate`);
      }
    } else {
      assert.equal(result.status, 'infeasible', `seed ${seed}`);
    }
  }
});
