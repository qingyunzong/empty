import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from '../src/validate.js';
import { PlanError } from '../src/errors.js';

function baseSpec() {
  return {
    name: 'demo',
    budget: 20,
    target: { artifact: 'score', type: 'metric' },
    tasks: [
      { name: 'fetch', cost: 10, produces: [{ name: 'raw', type: 'file' }] },
      { name: 'evaluate', cost: 10, requires: 'fetch', produces: [{ name: 'score', type: 'metric' }] },
    ],
  };
}

test('valid spec passes static checks', () => {
  const validated = validateSpec(baseSpec());
  assert.equal(validated.budget, 20);
  assert.equal(validated.tasks.length, 2);
  assert.equal(validated.expressions.get('evaluate').kind, 'ref');
});

test('field type errors are rejected', () => {
  const cases = [
    (s) => { s.budget = '20'; },
    (s) => { s.budget = -1; },
    (s) => { s.tasks = {}; },
    (s) => { s.tasks[0].cost = 'cheap'; },
    (s) => { s.tasks[0].name = ''; },
    (s) => { s.tasks[0].requires = 42; },
    (s) => { s.tasks[0].produces = 'raw'; },
    (s) => { s.target = 'score'; },
  ];
  for (const mutate of cases) {
    const spec = baseSpec();
    mutate(spec);
    assert.throws(() => validateSpec(spec), (err) => err instanceof PlanError && err.code === 'E_FIELD_TYPE');
  }
});

test('unknown task reference in requires is a static error', () => {
  const spec = baseSpec();
  spec.tasks[1].requires = 'fetch & ghost';
  assert.throws(() => validateSpec(spec), (err) => err instanceof PlanError && err.code === 'E_MISSING_REF');
});

test('artifact types are limited to file, dataset, metric', () => {
  const spec = baseSpec();
  spec.tasks[0].produces[0].type = 'blob';
  assert.throws(() => validateSpec(spec), (err) => err instanceof PlanError && err.code === 'E_ARTIFACT_TYPE');
});

test('duplicate task names and duplicate artifacts are rejected', () => {
  const dupTask = baseSpec();
  dupTask.tasks.push({ name: 'fetch', cost: 1, produces: [] });
  assert.throws(() => validateSpec(dupTask), (err) => err.code === 'E_DUPLICATE_TASK');

  const dupArtifact = baseSpec();
  dupArtifact.tasks[1].produces.push({ name: 'raw', type: 'file' });
  assert.throws(() => validateSpec(dupArtifact), (err) => err.code === 'E_DUPLICATE_ARTIFACT');
});

test('target artifact must exist and its declared type must match the produced type', () => {
  const missing = baseSpec();
  missing.target = { artifact: 'nope', type: 'metric' };
  assert.throws(() => validateSpec(missing), (err) => err.code === 'E_MISSING_ARTIFACT');

  const miswritten = baseSpec();
  miswritten.target = { artifact: 'raw', type: 'metric' };
  assert.throws(
    () => validateSpec(miswritten),
    (err) => err instanceof PlanError && err.code === 'E_TARGET_TYPE' && /file/.test(err.message),
  );
});
