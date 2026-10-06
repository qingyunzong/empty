import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/event-bus.js';
import { sleep } from './helpers/util.js';

test('callback may await and then reentrantly publish; parent waits for it', async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.subscribe('root', async () => {
    order.push('root:start');
    await sleep(5);
    order.push('root:reenter');
    await bus.publishAsync('child', null);
    order.push('root:done');
  });
  bus.subscribe('child', async () => {
    order.push('child:start');
    await sleep(5);
    order.push('child:done');
  });
  await bus.publishAsync('root', null);
  assert.deepEqual(order, [
    'root:start',
    'root:reenter',
    'child:start',
    'child:done',
    'root:done',
  ]);
});

test('parent waits for fire-and-forget derived publishes to clean up', async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.subscribe('root', () => {
    void bus.publishAsync('child', null);
    order.push('root:callback');
  });
  bus.subscribe('child', async () => {
    await sleep(20);
    order.push('child:callback');
  });
  await bus.publishAsync('root', null);
  assert.deepEqual(order, ['root:callback', 'child:callback']);
});

test('grandchild publishes spawned after awaits are also awaited', async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.subscribe('a', async () => {
    await sleep(2);
    void bus.publishAsync('b', null); // fire-and-forget child
  });
  bus.subscribe('b', async () => {
    await sleep(2);
    void bus.publishAsync('c', null); // fire-and-forget grandchild
  });
  bus.subscribe('c', async () => {
    await sleep(10);
    order.push('c');
  });
  await bus.publishAsync('a', null);
  assert.deepEqual(order, ['c']);
});

test('snapshot callbacks are dispatched sequentially in subscription order', async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.subscribe('t', async () => {
    order.push('a:start');
    await sleep(10);
    order.push('a:end');
  });
  bus.subscribe('t', async () => {
    order.push('b:start');
    await sleep(1);
    order.push('b:end');
  });
  await bus.publishAsync('t', null);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('cancelling skips not-yet-started callbacks but lets in-flight ones finish', async () => {
  const bus = new EventBus();
  const controller = new AbortController();
  const calls: string[] = [];
  bus.subscribe('t', async () => {
    calls.push('a:start');
    controller.abort();
    await sleep(5);
    calls.push('a:end');
  });
  bus.subscribe('t', () => {
    calls.push('b');
  });
  const receipt = await bus.publishAsync('t', null, { signal: controller.signal });
  assert.deepEqual(calls, ['a:start', 'a:end']);
  assert.equal(receipt.cancelled, true);
  assert.equal(receipt.invoked, 1);
});

test('pre-aborted signal prevents any invocation', async () => {
  const bus = new EventBus();
  const controller = new AbortController();
  controller.abort();
  let invoked = 0;
  bus.subscribe('t', () => {
    invoked += 1;
  });
  const receipt = await bus.publishAsync('t', null, { signal: controller.signal });
  assert.equal(invoked, 0);
  assert.equal(receipt.cancelled, true);
});

test('callback context exposes the publish cancellation signal', async () => {
  const bus = new EventBus();
  const controller = new AbortController();
  const observed: boolean[] = [];
  bus.subscribe('t', async (_payload, ctx) => {
    controller.abort();
    observed.push(ctx.signal.aborted);
  });
  await bus.publishAsync('t', null, { signal: controller.signal });
  assert.deepEqual(observed, [true]);
});

test('cancelled publish still waits for derived publishes to clean up', async () => {
  const bus = new EventBus();
  const controller = new AbortController();
  const order: string[] = [];
  bus.subscribe('root', () => {
    void bus.publishAsync('child', null);
    controller.abort();
  });
  bus.subscribe('child', async () => {
    await sleep(10);
    order.push('child');
  });
  const receipt = await bus.publishAsync('root', null, { signal: controller.signal });
  assert.equal(receipt.cancelled, true);
  assert.deepEqual(order, ['child']);
});
