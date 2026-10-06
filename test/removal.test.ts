import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/event-bus.js';
import { sleep, watchdog } from './helpers/util.js';

test('removeAndWait from outside waits for in-flight callbacks', async () => {
  const bus = new EventBus();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  const subscription = bus.subscribe('t', async () => {
    await gate;
    finished = true;
  });
  const publishing = bus.publishAsync('t', null);
  await sleep(1); // let the callback start

  let removed = false;
  const removal = subscription.removeAndWait().then(() => {
    removed = true;
  });
  await sleep(10);
  assert.equal(removed, false, 'must keep waiting while the callback is in flight');

  release();
  await removal;
  assert.equal(removed, true);
  assert.equal(finished, true);
  await publishing;
  assert.equal(subscription.active, false);
});

test('a callback removing itself with removeAndWait does not self-await', async () => {
  const bus = new EventBus();
  const calls: string[] = [];
  bus.subscribe('t', async (_payload, ctx) => {
    await ctx.subscription.removeAndWait();
    calls.push('done');
  });
  await watchdog(bus.publishAsync('t', null));
  assert.deepEqual(calls, ['done']);
});

test('removing an ancestor subscription from a nested publish does not deadlock', async () => {
  const bus = new EventBus();
  const calls: string[] = [];
  const root = bus.subscribe('root', async () => {
    await bus.publishAsync('child', null);
    calls.push('root:done');
  });
  bus.subscribe('child', async () => {
    // The root callback is still in flight, waiting on this very publish.
    // Waiting for it here would be a circular wait; the bus must skip it.
    await root.removeAndWait();
    calls.push('child:done');
  });
  await watchdog(bus.publishAsync('root', null));
  assert.deepEqual(calls, ['child:done', 'root:done']);
});

test('removeAndWait waits for in-flight callbacks of other subscriptions', async () => {
  const bus = new EventBus();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const slow = bus.subscribe('t', async () => {
    await gate;
    events.push('slow:done');
  });
  bus.subscribe('t', async () => {
    await slow.removeAndWait();
    events.push('remover:done');
  });
  const publishing = watchdog(bus.publishAsync('t', null));
  await sleep(5);
  release();
  await publishing;
  assert.deepEqual(events, ['slow:done', 'remover:done']);
});

test('remove() detaches immediately without waiting', async () => {
  const bus = new EventBus();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  const subscription = bus.subscribe('t', async () => {
    await gate;
    finished = true;
  });
  const publishing = bus.publishAsync('t', null);
  await sleep(1);
  subscription.remove();
  assert.equal(subscription.active, false);
  assert.equal(finished, false, 'in-flight callback keeps running');
  release();
  await publishing;
  assert.equal(finished, true);
});

test('double removeAndWait is safe', async () => {
  const bus = new EventBus();
  const subscription = bus.subscribe('t', () => {});
  await Promise.all([subscription.removeAndWait(), subscription.removeAndWait()]);
  assert.equal(subscription.active, false);
});
