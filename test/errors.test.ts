import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/event-bus.js';
import { catchAsync, catchSync, sleep } from './helpers/util.js';

const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

function asAggregate(error: unknown): AggregateError {
  if (!(error instanceof AggregateError)) assert.fail('expected AggregateError');
  return error;
}

test('sync publish aggregates callback errors without blocking other callbacks', () => {
  const bus = new EventBus();
  const calls: string[] = [];
  bus.subscribe('t', () => {
    calls.push('a');
    throw new Error('E1');
  });
  bus.subscribe('t', () => {
    calls.push('b');
  });
  bus.subscribe('t', () => {
    calls.push('c');
    throw new Error('E2');
  });
  const error = catchSync(() => bus.publish('t', null));
  assert.deepEqual(asAggregate(error).errors.map(String), ['Error: E1', 'Error: E2']);
  assert.deepEqual(calls, ['a', 'b', 'c']);
});

test('async publish merges nested errors in publish-tree order', async () => {
  const bus = new EventBus();
  bus.subscribe('root', () => {
    throw new Error('E1');
  });
  bus.subscribe('root', async () => {
    // Awaits the derived publish and re-throws its aggregate: the aggregate
    // itself must not be double-counted, its errors merge at this position.
    await bus.publishAsync('child', null);
  });
  bus.subscribe('child', () => {
    throw new Error('E2');
  });
  bus.subscribe('root', () => {
    throw new Error('E3');
  });
  const error = await catchAsync(() => bus.publishAsync('root', null));
  assert.deepEqual(asAggregate(error).errors.map(String), ['Error: E1', 'Error: E2', 'Error: E3']);
});

test('fire-and-forget derived publish errors merge into the parent', async () => {
  const bus = new EventBus();
  bus.subscribe('root', () => {
    void bus.publishAsync('child', null); // never awaited
  });
  bus.subscribe('child', async () => {
    await sleep(5);
    throw new Error('late-child-error');
  });
  const error = await catchAsync(() => bus.publishAsync('root', null));
  assert.deepEqual(asAggregate(error).errors.map(String), ['Error: late-child-error']);
});

test('deeply nested tree order is chronological depth-first', async () => {
  const bus = new EventBus();
  bus.subscribe('a', async () => {
    throw new Error('A1');
  });
  bus.subscribe('a', async () => {
    // Catching the derived aggregate does NOT remove its errors from the
    // enclosing publish tree: aggregation is lossless.
    await bus.publishAsync('b', null).catch(() => {});
    throw new Error('A2');
  });
  bus.subscribe('b', async () => {
    await bus.publishAsync('c', null);
  });
  bus.subscribe('c', () => {
    throw new Error('C1');
  });
  bus.subscribe('b', () => {
    throw new Error('B1');
  });
  const error = await catchAsync(() => bus.publishAsync('a', null));
  assert.deepEqual(asAggregate(error).errors.map(String), ['Error: A1', 'Error: C1', 'Error: B1', 'Error: A2']);
});

test('sync publish rejects async callbacks as publish errors', () => {
  const bus = new EventBus();
  bus.subscribe('t', () => Promise.reject(new Error('must not crash')));
  const error = catchSync(() => bus.publish('t', null));
  const aggregate = asAggregate(error);
  assert.equal(aggregate.errors.length, 1);
  assert.match(String(aggregate.errors[0]), /returned a promise/);
});

test('errors of async publishes derived from a sync publish become late errors', async () => {
  const late: unknown[] = [];
  const bus = new EventBus({ onLateError: (error) => late.push(error) });
  bus.subscribe('t', () => {
    void bus.publishAsync('inner', null); // async child of a sync publish
  });
  bus.subscribe('inner', () => {
    throw new Error('orphaned');
  });
  bus.publish('t', null); // sync publish cannot wait for the async child
  await sleep(10);
  assert.equal(late.length, 1);
  assert.deepEqual(bus.drainLateErrors(), late);
  assert.deepEqual(bus.drainLateErrors(), []);
});

test('no unhandled rejections were produced', async () => {
  await sleep(20);
  assert.deepEqual(unhandled, []);
});
