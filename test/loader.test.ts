import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleLoader, CycleError } from '../src/loader.js';
import { ControlledLoader, Gate } from '../src/controlled-loader.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error(`timeout waiting for: ${what}`);
}

test('concurrent same-id requests merge into a single load', async () => {
  const ctl = new ControlledLoader();
  ctl.define('x', { value: 'X' });
  const loader = new ModuleLoader(ctl.load);

  const [first, second] = await Promise.all([loader.load('x'), loader.load('x')]);

  assert.equal(ctl.callCount('x'), 1);
  assert.strictEqual(first, second);
  assert.equal(first, 'X');
});

test('diamond sharing: shared module loads once, waiters never block each other', async () => {
  const ctl = new ControlledLoader();
  const gate = new Gate();
  ctl.define('a', { deps: ['b', 'c'] });
  ctl.define('b', { deps: ['d'] });
  ctl.define('c', { deps: ['d'] });
  ctl.define('d', { gate });
  const loader = new ModuleLoader(ctl.load);

  gate.hold();
  const pending = loader.load('a');

  // While d is held, both b and c must have requested it already: the second
  // requester shares the in-flight record instead of waiting on the first
  // requester's chain (no false cycle, no deadlock).
  await until(() => ctl.callCount('d') === 1, 'd to be requested');
  assert.equal(ctl.callCount('b'), 1);
  assert.equal(ctl.callCount('c'), 1);
  assert.equal(ctl.callCount('d'), 1);

  gate.open();
  const result = await pending;
  assert.equal(ctl.callCount('d'), 1);
  assert.deepStrictEqual(result, {
    id: 'a',
    deps: {
      b: { id: 'b', deps: { d: { id: 'd', deps: {} } } },
      c: { id: 'c', deps: { d: { id: 'd', deps: {} } } },
    },
  });
});

test('self dependency reports a one-node cycle', async () => {
  const ctl = new ControlledLoader();
  ctl.define('a', { deps: ['a'] });
  const loader = new ModuleLoader(ctl.load);

  await assert.rejects(loader.load('a'), (err: unknown) => {
    assert.ok(err instanceof CycleError);
    assert.deepStrictEqual([...err.cycle], ['a', 'a']);
    assert.equal(err.message, 'circular dependency: a -> a');
    return true;
  });
});

test('cycle error reports the shortest loop in lexicographic order', async () => {
  const ctl = new ControlledLoader();
  ctl.define('x', { deps: ['c'] });
  ctl.define('c', { deps: ['b'] });
  ctl.define('b', { deps: ['c'] });
  const loader = new ModuleLoader(ctl.load);

  await assert.rejects(loader.load('x'), (err: unknown) => {
    assert.ok(err instanceof CycleError);
    // Detected while loading c under chain [x, c, b]; the reported loop
    // excludes the non-cyclic prefix x and starts at the smallest id.
    assert.deepStrictEqual([...err.cycle], ['b', 'c', 'b']);
    assert.equal(err.message, 'circular dependency: b -> c -> b');
    return true;
  });
});

test('cycle failure evicts the batch so a fixed graph can be retried', async () => {
  const ctl = new ControlledLoader();
  ctl.define('a', { deps: ['b'] });
  ctl.define('b', { deps: ['a'] });
  const loader = new ModuleLoader(ctl.load);

  await assert.rejects(loader.load('a'), /circular dependency: a -> b -> a/);

  ctl.define('b', { value: 'B' });
  const result = await loader.load('a');

  assert.deepStrictEqual(result, { id: 'a', deps: { b: 'B' } });
  assert.equal(ctl.callCount('a'), 2);
  assert.equal(ctl.callCount('b'), 2);
});

test('a failed load evicts only its own generation from the cache', async () => {
  const ctl = new ControlledLoader();
  const loader = new ModuleLoader(ctl.load);

  ctl.define('k', { value: 'K' });
  await loader.load('k');
  assert.equal(ctl.callCount('k'), 1);

  ctl.define('a', { deps: ['k', 'ok', 'bad'] });
  ctl.define('ok', { value: 'OK' });
  ctl.define('bad', { failTimes: 1 });
  await assert.rejects(loader.load('a'), /load failed: bad/);

  // Older generation survives the failure.
  await loader.load('k');
  assert.equal(ctl.callCount('k'), 1);

  // Retry: same-generation records (a, ok, bad) were evicted and reload,
  // while k is still served from its earlier-generation cache entry.
  const result = await loader.load('a');
  assert.deepStrictEqual(result, { id: 'a', deps: { k: 'K', ok: 'OK', bad: { id: 'bad', deps: {} } } });
  assert.equal(ctl.callCount('a'), 2);
  assert.equal(ctl.callCount('ok'), 2);
  assert.equal(ctl.callCount('bad'), 2);
  assert.equal(ctl.callCount('k'), 1);
});

test('shared failure reaches every waiter and the retry reloads once', async () => {
  const ctl = new ControlledLoader();
  ctl.define('a', { deps: ['b', 'c'] });
  ctl.define('b', { deps: ['d'] });
  ctl.define('c', { deps: ['d'] });
  ctl.define('d', { failTimes: 1, value: 'D' });
  const loader = new ModuleLoader(ctl.load);

  await assert.rejects(loader.load('a'), /load failed: d/);
  assert.equal(ctl.callCount('d'), 1);

  const result = await loader.load('a');
  assert.equal(ctl.callCount('d'), 2);
  assert.deepStrictEqual(result, {
    id: 'a',
    deps: { b: { id: 'b', deps: { d: 'D' } }, c: { id: 'c', deps: { d: 'D' } } },
  });
});

test('dependency values propagate to the parent module', async () => {
  const ctl = new ControlledLoader();
  ctl.define('leaf', { value: 42 });
  ctl.define('parent', { deps: ['leaf'] });
  const loader = new ModuleLoader(ctl.load);

  assert.deepStrictEqual(await loader.load('parent'), { id: 'parent', deps: { leaf: 42 } });
});
