import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProblemError,
  defineProblem,
  enumerateSolutions,
  isValidAssignment,
  sampleRandom,
} from '../src/index.js';

const small = defineProblem({
  vars: [
    { name: 'x', min: 0, max: 3 },
    { name: 'y', min: 0, max: 3 },
  ],
  constraints: [
    { name: 'sum', vars: ['x', 'y'], check: ({ x, y }) => (x ?? 0) + (y ?? 0) <= 3 },
  ],
});

test('exact enumeration finds every solution', () => {
  const result = enumerateSolutions(small);
  assert.equal(result.status, 'complete');
  // Pairs (x,y) in [0,3]^2 with x+y <= 3: 10 of them.
  assert.equal(result.samples.length, 10);
  for (const s of result.samples) {
    assert.ok(isValidAssignment(small, s));
  }
  assert.deepEqual(result.samples[0], { x: 0, y: 0 });
});

test('unsatisfiable problem reports unsatisfiable, not incomplete', () => {
  const impossible = defineProblem({
    vars: [{ name: 'x', min: 0, max: 2 }],
    constraints: [{ vars: ['x'], check: ({ x }) => (x ?? 0) > 10 }],
  });
  const result = enumerateSolutions(impossible);
  assert.equal(result.status, 'unsatisfiable');
  assert.equal(result.samples.length, 0);
});

test('exhausted budget reports incomplete, distinct from unsatisfiable', () => {
  const wide = defineProblem({
    vars: [
      { name: 'a', min: 0, max: 99 },
      { name: 'b', min: 0, max: 99 },
    ],
    constraints: [
      { vars: ['a', 'b'], check: ({ a, b }) => (a ?? 0) + (b ?? 0) === 198 },
    ],
  });
  const cut = enumerateSolutions(wide, { maxNodes: 5 });
  assert.equal(cut.status, 'incomplete');
  assert.notEqual(cut.status, 'unsatisfiable');

  const full = enumerateSolutions(wide);
  assert.equal(full.status, 'complete');
  assert.equal(full.samples.length, 1);
  assert.deepEqual(full.samples[0], { a: 99, b: 99 });
});

test('maxSolutions budget caps enumeration as incomplete', () => {
  const result = enumerateSolutions(small, { maxSolutions: 4 });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.samples.length, 4);
});

test('seeded random sampling is deterministic per seed', () => {
  const run1 = sampleRandom(small, { seed: 42, count: 5 });
  const run2 = sampleRandom(small, { seed: 42, count: 5 });
  assert.equal(run1.status, 'complete');
  assert.deepEqual(run1.samples, run2.samples);
  const other = sampleRandom(small, { seed: 7, count: 5 });
  assert.notDeepEqual(run1.samples, other.samples);
});

test('random samples are distinct and valid', () => {
  const result = sampleRandom(small, { seed: 1, count: 10 });
  assert.equal(result.status, 'complete');
  const keys = new Set(result.samples.map((s) => JSON.stringify(s)));
  assert.equal(keys.size, result.samples.length);
  for (const s of result.samples) {
    assert.ok(isValidAssignment(small, s));
  }
});

test('random sampling distinguishes unsatisfiable from budget-incomplete', () => {
  const impossible = defineProblem({
    vars: [{ name: 'x', min: 0, max: 5 }],
    constraints: [{ vars: ['x'], check: () => false }],
  });
  assert.equal(sampleRandom(impossible, { seed: 3, count: 1 }).status, 'unsatisfiable');

  const wide = defineProblem({
    vars: [
      { name: 'a', min: 0, max: 999 },
      { name: 'b', min: 0, max: 999 },
    ],
  });
  const cut = sampleRandom(wide, { seed: 3, count: 5, maxNodes: 3 });
  assert.equal(cut.status, 'incomplete');
  assert.ok(cut.samples.length < 5);
});

test('constraint referencing a missing variable is rejected', () => {
  assert.throws(
    () =>
      defineProblem({
        vars: [{ name: 'x', min: 0, max: 1 }],
        constraints: [{ name: 'bad', vars: ['x', 'ghost'], check: () => true }],
      }),
    (err: unknown) =>
      err instanceof ProblemError && /missing variable.*ghost/.test((err as Error).message),
  );
});

test('invalid variable definitions are rejected', () => {
  assert.throws(() => defineProblem({ vars: [{ name: 'x', min: 2, max: 1 }] }), ProblemError);
  assert.throws(
    () =>
      defineProblem({
        vars: [
          { name: 'x', min: 0, max: 1 },
          { name: 'x', min: 0, max: 1 },
        ],
      }),
    ProblemError,
  );
});
