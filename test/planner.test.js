import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from '../src/validate.js';
import { findOptimalPlans } from '../src/planner.js';
import { PlanError } from '../src/errors.js';

// Acceptance fixture: two symmetric ways to reach the target metric.
function acceptanceSpec(budget) {
  return {
    name: 'acceptance',
    budget,
    target: { artifact: 'score', type: 'metric' },
    tasks: [
      { name: 'fetch', cost: 10, produces: [{ name: 'raw', type: 'file' }] },
      { name: 'synth', cost: 10, produces: [{ name: 'raw2', type: 'dataset' }] },
      { name: 'evaluate', cost: 10, requires: 'fetch | synth', produces: [{ name: 'score', type: 'metric' }] },
    ],
  };
}

test('acceptance 1: budget 20 returns both hand-enumerated tied optima', () => {
  const plans = findOptimalPlans(validateSpec(acceptanceSpec(20)));
  assert.deepEqual(plans, [
    { tasks: ['evaluate', 'fetch'], cost: 20 },
    { tasks: ['evaluate', 'synth'], cost: 20 },
  ]);
});

test('acceptance 2: budget 19 clearly reports no feasible set', () => {
  assert.throws(
    () => findOptimalPlans(validateSpec(acceptanceSpec(19))),
    (err) => err instanceof PlanError && err.code === 'E_NO_FEASIBLE_SET' && /19/.test(err.message),
  );
});

test('dependency closure: conjunctive requires pulls in all dependencies', () => {
  const spec = validateSpec({
    budget: 100,
    target: { artifact: 'm', type: 'metric' },
    tasks: [
      { name: 'a', cost: 5, produces: [{ name: 'f', type: 'file' }] },
      { name: 'b', cost: 5, produces: [{ name: 'd', type: 'dataset' }] },
      { name: 'c', cost: 5, requires: 'a & b', produces: [{ name: 'm', type: 'metric' }] },
    ],
  });
  const plans = findOptimalPlans(spec);
  assert.deepEqual(plans, [{ tasks: ['a', 'b', 'c'], cost: 15 }]);
});

test('cheaper set wins among maximum-cardinality sets; equal-cost ties are all returned', () => {
  const spec = validateSpec({
    budget: 20,
    target: { artifact: 'm', type: 'metric' },
    tasks: [
      { name: 'x', cost: 9, produces: [{ name: 'f1', type: 'file' }] },
      { name: 'y', cost: 10, produces: [{ name: 'f2', type: 'file' }] },
      { name: 'z', cost: 10, requires: 'x | y', produces: [{ name: 'm', type: 'metric' }] },
    ],
  });
  const plans = findOptimalPlans(spec);
  assert.deepEqual(plans, [{ tasks: ['x', 'z'], cost: 19 }]);
});

test('negation in requires is honored during closure checks', () => {
  const spec = validateSpec({
    budget: 100,
    target: { artifact: 'm', type: 'metric' },
    tasks: [
      { name: 'legacy', cost: 1, produces: [{ name: 'old', type: 'file' }] },
      { name: 'modern', cost: 1, requires: '!legacy', produces: [{ name: 'm', type: 'metric' }] },
    ],
  });
  const plans = findOptimalPlans(spec);
  assert.deepEqual(plans, [{ tasks: ['modern'], cost: 1 }]);
});

test('tied optima are sorted lexicographically by task name sequence', () => {
  const spec = validateSpec({
    budget: 4,
    target: { artifact: 'm', type: 'metric' },
    tasks: [
      { name: 'beta', cost: 2, produces: [{ name: 'd1', type: 'dataset' }] },
      { name: 'alpha', cost: 2, produces: [{ name: 'd2', type: 'dataset' }] },
      { name: 'report', cost: 2, requires: 'alpha | beta', produces: [{ name: 'm', type: 'metric' }] },
    ],
  });
  const plans = findOptimalPlans(spec);
  assert.deepEqual(plans, [
    { tasks: ['alpha', 'report'], cost: 4 },
    { tasks: ['beta', 'report'], cost: 4 },
  ]);
});
