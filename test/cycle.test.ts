import { test } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { CycleError, ModuleLoader } from '../src/module-loader.js';
import { ControllableLoader } from '../src/controllable-loader.js';

function cycleMessage(error: unknown): string {
  ok(error instanceof CycleError, `expected a CycleError, got ${String(error)}`);
  return (error as CycleError).message;
}

test('cycle is reported canonically regardless of the entry module', async () => {
  const loader = new ControllableLoader();
  loader
    .define('a', { dependencies: ['b'], exports: 'A' })
    .define('b', { dependencies: ['c'], exports: 'B' })
    .define('c', { dependencies: ['a'], exports: 'C' });
  const modules = new ModuleLoader(loader.load);

  // Entering at "a": the raw detection is c -> a, but the report is rotated.
  await rejects(modules.load('a'), (error: unknown) => {
    equal(cycleMessage(error), 'Circular dependency detected: a -> b -> c -> a');
    deepEqual((error as CycleError).cycle, ['a', 'b', 'c', 'a']);
    return true;
  });

  // The failed generation was evicted, so entering at "c" re-fetches and
  // still reports the same canonical cycle.
  await rejects(modules.load('c'), (error: unknown) => {
    equal(cycleMessage(error), 'Circular dependency detected: a -> b -> c -> a');
    return true;
  });
});

test('a module depending on itself forms a one-node cycle', async () => {
  const loader = new ControllableLoader();
  loader.define('a', { dependencies: ['a'], exports: 'A' });
  const modules = new ModuleLoader(loader.load);

  await rejects(modules.load('a'), (error: unknown) => {
    equal(cycleMessage(error), 'Circular dependency detected: a -> a');
    return true;
  });
});

test('the shortest cycle through the closing edge is reported', async () => {
  const loader = new ControllableLoader();
  loader
    .define('a', { dependencies: ['b', 'c'], exports: 'A' })
    .define('b', { dependencies: ['d'], exports: 'B' })
    .define('c', { dependencies: ['d'], exports: 'C' })
    .define('d', { dependencies: ['b'], exports: 'D' });
  const modules = new ModuleLoader(loader.load);

  // The loading chain is a -> b -> d, but the cycle is just b -> d -> b.
  await rejects(modules.load('a'), (error: unknown) => {
    equal(cycleMessage(error), 'Circular dependency detected: b -> d -> b');
    return true;
  });
});

test('equal-length cycles are tie-broken lexicographically', async () => {
  const loader = new ControllableLoader();
  loader
    .define('c', { dependencies: ['d', 'f'], exports: 'C' })
    .define('d', { dependencies: ['e'], exports: 'D' })
    .define('f', { dependencies: ['e'], exports: 'F' })
    .define('e', { dependencies: ['c'], exports: 'E' });
  const modules = new ModuleLoader(loader.load);

  // Both c -> d -> e -> c and c -> f -> e -> c close; "d" < "f" wins.
  await rejects(modules.load('c'), (error: unknown) => {
    equal(cycleMessage(error), 'Circular dependency detected: c -> d -> e -> c');
    return true;
  });
});

test('mutually dependent concurrent roots reject instead of waiting on each other', async () => {
  const loader = new ControllableLoader();
  loader
    .define('m', { dependencies: ['n'], exports: 'M' })
    .define('n', { dependencies: ['m'], exports: 'N' });
  const modules = new ModuleLoader(loader.load);

  const results = await Promise.allSettled([modules.load('m'), modules.load('n')]);
  ok(results[0].status === 'rejected');
  ok(results[1].status === 'rejected');
  for (const result of results) {
    if (result.status === 'rejected') {
      equal(cycleMessage(result.reason), 'Circular dependency detected: m -> n -> m');
    }
  }
});
