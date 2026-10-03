import test from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../src/planner.js';
import { PlannerError } from '../src/errors.js';

// Hand-enumerated fixture:
//   t1 -> raw.data (dataset, cost 2)
//   t2 -> alt.data (dataset, cost 2)
//   t3 -> report.out (file, cost 2, needs raw.data)
//   t4 -> report.out (file, cost 2, needs alt.data)
// Budget 6, target report.out.
// Feasible sets reaching the target:
//   {t1,t3} cost 4 | {t2,t4} cost 4 | {t1,t2,t3} cost 6 | {t1,t2,t4} cost 6
//   ({t1,t3,t4} and {t2,t3,t4} are not closed; all four cost 8 > 6)
// Optimal = max size 3, min cost 6 -> exactly two tied sets.
function makeSpec(overrides = {}) {
  return {
    budget: 6,
    targets: ['report.out'],
    tasks: [
      { name: 't1', cost: 2, produces: [{ name: 'raw.data', type: 'dataset' }] },
      { name: 't2', cost: 2, produces: [{ name: 'alt.data', type: 'dataset' }] },
      { name: 't3', cost: 2, produces: [{ name: 'report.out', type: 'file' }], requires: 'raw.data' },
      { name: 't4', cost: 2, produces: [{ name: 'report.out', type: 'file' }], requires: 'alt.data' },
    ],
    ...overrides,
  };
}

test('acceptance 1: returns both hand-enumerated tied-optimal sets', () => {
  const result = plan(makeSpec());
  assert.equal(result.size, 3);
  assert.equal(result.cost, 6);
  assert.deepEqual(result.plans, [
    ['t1', 't2', 't3'],
    ['t1', 't2', 't4'],
  ]);
});

test('acceptance 2: lowered budget yields an explicit no-feasible-set error', () => {
  assert.throws(
    () => plan(makeSpec({ budget: 3 })),
    (e) => e instanceof PlannerError && e.code === 'E_NO_FEASIBLE' && /no feasible task set/.test(e.message),
  );
});

test('tied sets are sorted lexicographically by task-name sequence', () => {
  const result = plan(makeSpec());
  const sorted = [...result.plans].sort((a, b) => a.join('').localeCompare(b.join('')));
  assert.deepEqual(result.plans, sorted);
});

test('dependency closure is enforced', () => {
  const spec = makeSpec();
  spec.tasks[2].requires = 'raw.data & checkpoint.bin'; // unproducible artifact
  assert.throws(() => plan(spec), (e) => e.code === 'E_UNKNOWN_REF');
});

test('field type errors are rejected', () => {
  assert.throws(() => plan(makeSpec({ budget: '6' })), (e) => e.code === 'E_FIELD_TYPE');
  const badCost = makeSpec();
  badCost.tasks = badCost.tasks.map((t) => (t.name === 't1' ? { ...t, cost: -1 } : t));
  assert.throws(() => plan(badCost), (e) => e.code === 'E_FIELD_TYPE');
});

test('artifact type outside file|dataset|metric is rejected', () => {
  const spec = makeSpec();
  spec.tasks = spec.tasks.map((t) => (t.name === 't1'
    ? { ...t, produces: [{ name: 'raw.data', type: 'blob' }] }
    : t));
  assert.throws(() => plan(spec), (e) => e.code === 'E_BAD_ARTIFACT_TYPE');
});

test('missing reference is a static error', () => {
  const spec = makeSpec();
  spec.tasks = spec.tasks.map((t) => (t.name === 't3' ? { ...t, requires: 'ghost.data' } : t));
  assert.throws(() => plan(spec), (e) => e.code === 'E_UNKNOWN_REF');
});
