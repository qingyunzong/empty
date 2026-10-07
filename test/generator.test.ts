import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidProblemError,
  UnknownVariableError,
  bruteForceSolutions,
  defineProblem,
  enumerateSolutions,
  sampleRandom,
  satisfies,
  shrink,
  spaceSize,
} from '../src/index.js';
import type { Assignment, Problem } from '../src/index.js';

const keyOf = (a: Assignment): string => JSON.stringify(a);
const keySet = (list: readonly Assignment[]): Set<string> => new Set(list.map(keyOf));

const smallProblem = (): Problem =>
  defineProblem({
    variables: [
      { name: 'a', min: -2, max: 2 },
      { name: 'b', min: 0, max: 3 },
      { name: 'c', min: 1, max: 2 },
    ],
    constraints: [
      { name: 'sum', vars: ['a', 'b'], check: (g) => g('a') + g('b') >= 1 },
      { name: 'cap', vars: ['b', 'c'], check: (g) => g('b') * g('c') <= 4 },
      { name: 'gap', vars: ['a', 'c'], check: (g) => g('c') - g('a') >= 0 },
    ],
  });

test('rejects constraints that depend on missing variables', () => {
  assert.throws(
    () =>
      defineProblem({
        variables: [{ name: 'x', min: 0, max: 5 }],
        constraints: [{ vars: ['x', 'y'], check: (g) => g('x') < g('y') }],
      }),
    (err: unknown) =>
      err instanceof UnknownVariableError && deep(err.missing, ['y']),
  );
  assert.throws(
    () =>
      defineProblem({
        variables: [{ name: 'x', min: 0, max: 1 }],
        constraints: [
          { vars: ['p'], check: (g) => g('p') > 0 },
          { vars: ['q'], check: (g) => g('q') > 0 },
        ],
      }),
    (err: unknown) => err instanceof UnknownVariableError && deep(err.missing, ['p', 'q']),
  );
});

const deep = (a: unknown, b: unknown): boolean => {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
};

test('rejects invalid variable definitions', () => {
  assert.throws(
    () => defineProblem({ variables: [{ name: 'x', min: 3, max: 1 }] }),
    InvalidProblemError,
  );
  assert.throws(
    () => defineProblem({ variables: [{ name: 'x', min: 0, max: 1.5 }] }),
    InvalidProblemError,
  );
  assert.throws(
    () =>
      defineProblem({
        variables: [
          { name: 'x', min: 0, max: 1 },
          { name: 'x', min: 0, max: 1 },
        ],
      }),
    InvalidProblemError,
  );
});

test('exact enumeration matches brute force and yields only valid samples', () => {
  const problem = smallProblem();
  const result = enumerateSolutions(problem);
  assert.equal(result.status, 'complete');

  // No invalid sample is ever produced.
  for (const sample of result.samples) {
    assert.ok(satisfies(problem, sample), `invalid sample: ${keyOf(sample)}`);
  }
  // No duplicates.
  assert.equal(keySet(result.samples).size, result.samples.length);
  // Pruned enumeration finds exactly the brute-force solution set.
  const expected = bruteForceSolutions(problem);
  assert.ok(expected.length > 0, 'test problem should have solutions');
  assert.deepEqual(keySet(result.samples), keySet(expected));
  assert.equal(result.examined, expected.length);
});

test('distinguishes unsatisfiable from budget-exhausted', () => {
  const unsat = defineProblem({
    variables: [{ name: 'x', min: 0, max: 3 }],
    constraints: [{ vars: ['x'], check: (g) => g('x') > 10 }],
  });
  const unsatResult = enumerateSolutions(unsat);
  assert.equal(unsatResult.status, 'unsatisfiable');
  assert.equal(unsatResult.samples.length, 0);

  const wide = defineProblem({
    variables: [
      { name: 'x', min: 0, max: 9 },
      { name: 'y', min: 0, max: 9 },
    ],
  });
  const exhausted = enumerateSolutions(wide, { budget: 5 });
  assert.equal(exhausted.status, 'budget-exhausted');
  assert.equal(exhausted.samples.length, 5);

  const capped = enumerateSolutions(wide, { maxSamples: 3 });
  assert.equal(capped.status, 'budget-exhausted');
  assert.equal(capped.samples.length, 3);

  // Same unsat problem with a generous budget is still 'unsatisfiable',
  // never misreported as 'budget-exhausted'.
  const unsatBigBudget = enumerateSolutions(unsat, { budget: 1_000_000 });
  assert.equal(unsatBigBudget.status, 'unsatisfiable');
});

test('seeded random sampling is reproducible and valid', () => {
  const problem = defineProblem({
    variables: [
      { name: 'x', min: 0, max: 1000 },
      { name: 'y', min: 0, max: 1000 },
    ],
    constraints: [{ vars: ['x', 'y'], check: (g) => g('x') + g('y') >= 500 }],
  });
  const first = sampleRandom(problem, { seed: 42, count: 10 });
  const second = sampleRandom(problem, { seed: 42, count: 10 });
  assert.equal(first.status, 'complete');
  assert.equal(first.samples.length, 10);
  assert.deepEqual(first.samples, second.samples);
  for (const sample of first.samples) {
    assert.ok(satisfies(problem, sample));
  }
  assert.equal(keySet(first.samples).size, first.samples.length, 'samples are unique');
});

test('random sampling on short domains decides unsatisfiable exactly', () => {
  const impossible = defineProblem({
    variables: [{ name: 'x', min: 0, max: 4 }],
    constraints: [{ vars: ['x'], check: (g) => g('x') > 100 }],
  });
  const result = sampleRandom(impossible, { seed: 1, count: 3, maxAttempts: 50 });
  assert.equal(result.status, 'unsatisfiable');
  assert.equal(result.samples.length, 0);
});

test('random sampling on large domains reports budget-exhausted, not unsatisfiable', () => {
  const huge = defineProblem({
    variables: [
      { name: 'a', min: 0, max: 1_000_000 },
      { name: 'b', min: 0, max: 1_000_000 },
    ],
    // Actually unsatisfiable, but the space is far too large to prove it
    // within the attempt budget.
    constraints: [{ vars: ['a', 'b'], check: (g) => g('a') + g('b') > 3_000_000 }],
  });
  const result = sampleRandom(huge, { seed: 7, count: 5, maxAttempts: 200 });
  assert.equal(result.status, 'budget-exhausted');
  assert.equal(result.samples.length, 0);
  assert.equal(result.examined, 200);
});

test('shrink preserves constraints and never grows values', () => {
  const problem = defineProblem({
    variables: [
      { name: 'x', min: 0, max: 10 },
      { name: 'y', min: 0, max: 10 },
    ],
    constraints: [
      { vars: ['x', 'y'], check: (g) => g('x') + g('y') >= 8 },
      { vars: ['x', 'y'], check: (g) => g('x') <= 2 * g('y') + 1 },
    ],
  });
  const shrunk = shrink(problem, { x: 9, y: 9 });
  assert.ok(satisfies(problem, shrunk));
  assert.ok((shrunk.x as number) <= 9 && (shrunk.y as number) <= 9);
  assert.ok((shrunk.x as number) + (shrunk.y as number) >= 8);

  // Shrinking is idempotent.
  assert.deepEqual(shrink(problem, shrunk), shrunk);

  // Shrinking an invalid assignment is rejected.
  assert.throws(() => shrink(problem, { x: 0, y: 0 }));
});

test('shrink keeps every enumerated sample of a short domain valid', () => {
  const problem = smallProblem();
  const { samples } = enumerateSolutions(problem);
  for (const sample of samples) {
    const shrunk = shrink(problem, sample);
    assert.ok(satisfies(problem, shrunk), `shrink broke constraints: ${keyOf(shrunk)}`);
    for (const v of problem.variables) {
      assert.ok((shrunk[v.name] as number) <= (sample[v.name] as number));
      assert.ok((shrunk[v.name] as number) >= v.min);
    }
  }
});

test('spaceSize counts the cartesian product with a cap', () => {
  const problem = smallProblem();
  assert.equal(spaceSize(problem), 5 * 4 * 2);
  assert.equal(spaceSize(problem, 10), 10);
});
