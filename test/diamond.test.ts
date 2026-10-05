import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { ModuleLoader } from '../src/module-loader.js';
import { ControllableLoader } from '../src/controllable-loader.js';

test('diamond: a shared dependency is fetched once and shared by all dependents', async () => {
  const loader = new ControllableLoader();
  const dExports = { value: 'D' };
  loader
    .define('a', { dependencies: ['b', 'c'], exports: 'A' })
    .define('b', { dependencies: ['d'], exports: 'B' })
    .define('c', { dependencies: ['d'], exports: 'C' })
    .define('d', { exports: dExports })
    .gate('d'); // hold d so b and c both request it while it is in flight

  const modules = new ModuleLoader(loader.load);
  const pending = modules.load('a');

  // b and c have both been fetched and d is in flight (still gated).
  await loader.whenCalled('b');
  await loader.whenCalled('c');
  await loader.whenCalled('d');
  await new Promise<void>((resolve) => setImmediate(resolve));
  loader.release('d');

  equal(await pending, 'A');
  equal(loader.calls('a'), 1);
  equal(loader.calls('b'), 1);
  equal(loader.calls('c'), 1);
  equal(loader.calls('d'), 1); // merged, not fetched once per dependent

  // Everyone observes the very same module object.
  equal(await modules.load('d'), dExports);
  equal(loader.calls('d'), 1);
});

test('concurrent same-ID requests share a single in-flight load', async () => {
  const loader = new ControllableLoader();
  const shared = { tag: 'x' };
  loader.define('x', { exports: shared }).gate('x');

  const modules = new ModuleLoader(loader.load);
  const first = modules.load('x');
  const second = modules.load('x');
  await loader.whenCalled('x');
  loader.release('x');

  const [a, b] = await Promise.all([first, second]);
  equal(a, shared);
  equal(b, shared);
  equal(loader.calls('x'), 1);
});
