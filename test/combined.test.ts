import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireAll, TimeoutError, type ResourceRequest } from '../src/combined.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

test('all succeed: results in application order, nothing released', async () => {
  const d = [deferred<string>(), deferred<string>(), deferred<string>()];
  const released: string[] = [];
  const make = (i: number): ResourceRequest<string> => ({
    acquire: () => d[i]!.promise,
    release: () => {
      released.push(`r${i}`);
    },
  });
  const p = acquireAll([make(0), make(1), make(2)]);
  d[1]!.resolve('b');
  d[0]!.resolve('a');
  d[2]!.resolve('c');
  assert.deepEqual(await p, ['a', 'b', 'c']);
  assert.deepEqual(released, []);
});

test('failure cancels the rest; acquired released in reverse application order', async () => {
  const d = [deferred<string>(), deferred<string>(), deferred<string>()];
  const signals: AbortSignal[] = [];
  const released: string[] = [];
  const make = (i: number): ResourceRequest<string> => ({
    acquire: (signal) => {
      signals[i] = signal;
      return d[i]!.promise;
    },
    release: () => {
      released.push(`r${i}`);
    },
  });
  const boom = new Error('boom');
  const p = acquireAll([make(0), make(1), make(2)]);
  d[0]!.resolve('a');
  d[1]!.resolve('b');
  await flush();
  d[2]!.reject(boom);
  await assert.rejects(p, (err) => err === boom);
  assert.deepEqual(released, ['r1', 'r0']);
  assert.ok(signals.every((s) => s.aborted));
});

test('error selection follows application order, not chronological order', async () => {
  const d0 = deferred<string>();
  const d1 = deferred<string>();
  const errLate = new Error('index-1 fails first');
  const errEarly = new Error('index-0 fails later');
  const p = acquireAll([
    { acquire: () => d0.promise, release: () => {} },
    { acquire: () => d1.promise, release: () => {} },
  ]);
  d1.reject(errLate);
  await flush();
  d0.reject(errEarly);
  await assert.rejects(p, (err) => err === errEarly);
});

test('late success after cancellation is released exactly once; error unchanged', async () => {
  const d0 = deferred<string>();
  const d1 = deferred<string>();
  const released: string[] = [];
  const boom = new Error('boom');
  const p = acquireAll([
    {
      acquire: () => d0.promise,
      release: () => {
        released.push('r0');
      },
    },
    {
      acquire: () => d1.promise,
      release: () => {
        released.push('r1');
      },
    },
  ]);
  d0.reject(boom);
  await flush();
  d1.resolve('late-resource');
  await assert.rejects(p, (err) => err === boom);
  assert.deepEqual(released, ['r1']);
  await flush();
  assert.deepEqual(released, ['r1']);
});

test('timeout cancels the rest and yields TimeoutError', async () => {
  const never = new Promise<string>(() => {});
  let aborted = false;
  const p = acquireAll([
    { acquire: () => never, release: () => {}, timeoutMs: 20 },
    {
      acquire: (signal) =>
        new Promise<string>((_, rej) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            rej(new Error('aborted'));
          });
        }),
      release: () => {},
    },
  ]);
  await assert.rejects(p, (err) => err instanceof TimeoutError && err.index === 0);
  assert.ok(aborted);
});

test('late success after timeout is still released; TimeoutError unchanged', async () => {
  const slow = deferred<string>();
  const released: string[] = [];
  const p = acquireAll([
    {
      acquire: () => slow.promise,
      release: () => {
        released.push('r0');
      },
      timeoutMs: 20,
    },
  ]);
  await assert.rejects(p, (err) => err instanceof TimeoutError);
  slow.resolve('too-late');
  await flush();
  assert.deepEqual(released, ['r0']);
});

test('each acquired resource is released exactly once across multiple failures', async () => {
  const d = [deferred<string>(), deferred<string>(), deferred<string>()];
  let releaseCount = 0;
  const make = (i: number): ResourceRequest<string> => ({
    acquire: () => d[i]!.promise,
    release: () => {
      releaseCount++;
    },
  });
  const p = acquireAll([make(0), make(1), make(2)]);
  d[0]!.resolve('ok');
  await flush();
  d[1]!.reject(new Error('e1'));
  d[2]!.reject(new Error('e2'));
  await assert.rejects(p);
  assert.equal(releaseCount, 1);
});

test('release errors do not mask the original error', async () => {
  const d0 = deferred<string>();
  const d1 = deferred<string>();
  const boom = new Error('boom');
  const p = acquireAll([
    {
      acquire: () => d0.promise,
      release: () => {
        throw new Error('release failed');
      },
    },
    { acquire: () => d1.promise, release: () => {} },
  ]);
  d0!.resolve('res');
  await flush();
  d1.reject(boom);
  await assert.rejects(p, (err) => err === boom);
});
