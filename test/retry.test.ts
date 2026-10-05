import { test } from 'node:test';
import { equal, rejects } from 'node:assert/strict';
import { CycleError, ModuleLoader } from '../src/module-loader.js';
import { ControllableLoader } from '../src/controllable-loader.js';

test('a failed load evicts its generation so a retry re-fetches and succeeds', async () => {
  const loader = new ControllableLoader();
  loader
    .define('a', { dependencies: ['b'], exports: 'A' })
    .define('b', { exports: 'B' })
    .failNext('b', new Error('boom'));
  const modules = new ModuleLoader(loader.load);

  await rejects(modules.load('a'), /boom/);
  equal(loader.calls('b'), 1);

  equal(await modules.load('a'), 'A');
  equal(loader.calls('a'), 2);
  equal(loader.calls('b'), 2);
});

test('a failure clears only its own generation, older generations stay cached', async () => {
  const loader = new ControllableLoader();
  loader
    .define('c', { exports: 'C' })
    .define('d', { dependencies: ['c', 'helper', 'bad'], exports: 'D' })
    .define('helper', { exports: 'H' })
    .define('bad', { exports: 'B' });
  const modules = new ModuleLoader(loader.load);

  equal(await modules.load('c'), 'C'); // generation 1 succeeds
  equal(loader.calls('c'), 1);

  loader.failNext('bad', new Error('bad boom'));
  await rejects(modules.load('d'), /bad boom/); // generation 2 fails

  equal(await modules.load('d'), 'D'); // generation 3 retries
  equal(loader.calls('c'), 1); // older generation untouched
  equal(loader.calls('helper'), 2); // same failed generation: evicted
  equal(loader.calls('bad'), 2); // the failed module itself: evicted
  equal(loader.calls('d'), 2);
});

test('after a cycle rejection the generation is cleared and a fixed graph loads', async () => {
  const loader = new ControllableLoader();
  loader
    .define('a', { dependencies: ['b'], exports: 'A' })
    .define('b', { dependencies: ['a'], exports: 'B' });
  const modules = new ModuleLoader(loader.load);

  await rejects(modules.load('a'), CycleError);

  loader.define('b', { dependencies: [], exports: 'B' }); // break the cycle
  equal(await modules.load('a'), 'A');
  equal(loader.calls('a'), 2);
  equal(loader.calls('b'), 2);
});
