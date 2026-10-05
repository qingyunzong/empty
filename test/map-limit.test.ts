import test from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { mapLimit, MapLimitError } from '../src/map-limit.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

test('limits concurrency and resolves results in input order', async () => {
  const inputs = [0, 1, 2, 3, 4, 5];
  const gates = inputs.map(() => deferred<string>());
  const started: number[] = [];
  let active = 0;
  let maxActive = 0;

  const promise = mapLimit(inputs, 2, (item, index) => {
    started.push(index);
    active += 1;
    maxActive = Math.max(maxActive, active);
    return gates[item]!.promise.then((value) => {
      active -= 1;
      return value;
    });
  });

  await tick();
  deepEqual(started, [0, 1]);

  gates[1]!.resolve('one');
  await tick();
  deepEqual(started, [0, 1, 2]);

  gates[2]!.resolve('two');
  gates[0]!.resolve('zero');
  await tick();
  deepEqual(started, [0, 1, 2, 3, 4]);

  gates[4]!.resolve('four');
  gates[3]!.resolve('three');
  await tick();
  deepEqual(started, [0, 1, 2, 3, 4, 5]);
  gates[5]!.resolve('five');

  const results = await promise;
  deepEqual(results, ['zero', 'one', 'two', 'three', 'four', 'five']);
  equal(maxActive, 2);
});

test('failure stops launching later items, started items still settle, smallest failed index wins with success prefix', async () => {
  const inputs = [0, 1, 2, 3, 4];
  const gates = inputs.map(() => deferred<string>());
  const started: number[] = [];
  const settledItems: number[] = [];

  const promise = mapLimit(inputs, 3, (item, index) => {
    started.push(index);
    return gates[item]!.promise.then(
      (value) => {
        settledItems.push(index);
        return value;
      },
      (reason: unknown) => {
        settledItems.push(index);
        throw reason;
      },
    );
  });

  await tick();
  deepEqual(started, [0, 1, 2]);

  gates[0]!.resolve('zero');
  await tick();
  deepEqual(started, [0, 1, 2, 3]);

  const error3 = new Error('fail-3');
  const error1 = new Error('fail-1');
  gates[3]!.reject(error3);
  await tick();
  deepEqual(started, [0, 1, 2, 3]);

  gates[1]!.reject(error1);
  gates[2]!.resolve('two');

  await rejects(promise, (reason: unknown) => {
    ok(reason instanceof MapLimitError);
    equal(reason.name, 'MapLimitError');
    equal(reason.index, 1);
    equal(reason.cause, error1);
    deepEqual(reason.partialResults, ['zero']);
    return true;
  });

  await tick();
  deepEqual(started, [0, 1, 2, 3]);
  deepEqual([...settledItems].sort(), [0, 1, 2, 3]);
});

test('out-of-order failures: later index rejects first, final error uses smallest failed index', async () => {
  const inputs = [0, 1, 2, 3];
  const gates = inputs.map(() => deferred<string>());
  const started: number[] = [];

  const promise = mapLimit(inputs, 2, (item, index) => {
    started.push(index);
    return gates[item]!.promise;
  });

  await tick();
  deepEqual(started, [0, 1]);

  const error1 = new Error('fail-1');
  const error0 = new Error('fail-0');
  gates[1]!.reject(error1);
  await tick();
  deepEqual(started, [0, 1]);

  gates[0]!.reject(error0);

  await rejects(promise, (reason: unknown) => {
    ok(reason instanceof MapLimitError);
    equal(reason.index, 0);
    equal(reason.cause, error0);
    deepEqual(reason.partialResults, []);
    return true;
  });

  await tick();
  deepEqual(started, [0, 1]);
});

test('caller abort cancels unstarted items while started items still settle', async () => {
  const inputs = [0, 1, 2, 3];
  const gates = inputs.map(() => deferred<string>());
  const started: number[] = [];
  const settledItems: number[] = [];
  const controller = new AbortController();

  const promise = mapLimit(
    inputs,
    2,
    (item, index) => {
      started.push(index);
      return gates[item]!.promise.then((value) => {
        settledItems.push(index);
        return value;
      });
    },
    { signal: controller.signal },
  );

  await tick();
  deepEqual(started, [0, 1]);

  const assertion = rejects(promise, (reason: unknown) => {
    ok(reason instanceof Error);
    equal(reason.name, 'AbortError');
    return true;
  });
  controller.abort();
  await assertion;

  await tick();
  deepEqual(started, [0, 1]);

  gates[0]!.resolve('zero');
  gates[1]!.resolve('one');
  await tick();
  deepEqual(settledItems, [0, 1]);
});

test('pre-aborted signal rejects before any item starts', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  await rejects(
    mapLimit(
      [1, 2, 3],
      2,
      () => {
        calls += 1;
        return Promise.resolve(0);
      },
      { signal: controller.signal },
    ),
    (reason: unknown) => reason instanceof Error && reason.name === 'AbortError',
  );
  equal(calls, 0);
});

test('mapper receives item, index and an AbortSignal', async () => {
  const seen: Array<[string, number]> = [];
  const results = await mapLimit(['a', 'b', 'c'], 5, (item, index, signal) => {
    seen.push([item, index]);
    ok(signal instanceof AbortSignal);
    return Promise.resolve(item.toUpperCase());
  });
  deepEqual(seen, [
    ['a', 0],
    ['b', 1],
    ['c', 2],
  ]);
  deepEqual(results, ['A', 'B', 'C']);
});

test('synchronous mapper throw is treated as item failure', async () => {
  const boom = new Error('boom');
  await rejects(
    mapLimit([0, 1], 1, (item) => {
      if (item === 0) throw boom;
      return Promise.resolve(item);
    }),
    (reason: unknown) =>
      reason instanceof MapLimitError && reason.index === 0 && reason.cause === boom,
  );
});

test('edge cases: empty input resolves, invalid concurrency rejected', async () => {
  deepEqual(await mapLimit<number, number>([], 3, (item) => item * 2), []);

  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await rejects(
      mapLimit([1], bad, (item) => item),
      (reason: unknown) => reason instanceof RangeError,
    );
  }
});
