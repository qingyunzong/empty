import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ObservableStore,
  type NotificationMeta,
} from '../src/store.js';

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function defer<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks (and one macrotask turn) run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Call<T> {
  state: T;
  meta: NotificationMeta;
}

function recorder<T>() {
  const calls: Call<T>[] = [];
  const observer = (state: T, meta: NotificationMeta) => {
    calls.push({ state, meta });
  };
  return { calls, observer };
}

test('commits synchronously but notifies observers asynchronously', async () => {
  const store = new ObservableStore(0);
  const { calls, observer } = recorder<number>();
  store.subscribe(observer);

  const version = store.setState(1);

  assert.equal(version, 1);
  assert.equal(store.getState(), 1, 'state is committed synchronously');
  assert.equal(calls.length, 0, 'observer not called synchronously');

  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state, 1);
  assert.deepEqual(calls[0].meta, { version: 1, skipped: null });
});

test('observer exceptions never roll back committed state', async () => {
  const store = new ObservableStore(0);
  const errors: unknown[] = [];
  const { calls, observer } = recorder<number>();

  store.subscribe(
    () => {
      throw new Error('sync boom');
    },
    { onError: (error) => errors.push(error) },
  );
  store.subscribe(
    async () => {
      throw new Error('async boom');
    },
    { onError: (error) => errors.push(error) },
  );
  store.subscribe(observer);

  store.setState(42);
  await tick();

  assert.equal(store.getState(), 42, 'committed state survives observer errors');
  assert.equal(store.getVersion(), 1);
  assert.equal(errors.length, 2, 'both failures surfaced via onError');
  assert.match(String((errors[0] as Error).message), /boom/);
  assert.equal(calls.length, 1, 'healthy observer still notified');
  assert.equal(calls[0].state, 42);
});

test('slow observers receive only the latest version plus the skipped range', async () => {
  const store = new ObservableStore(0);
  const gate = defer();
  const calls: Call<number>[] = [];
  let first = true;

  store.subscribe(async (state, meta) => {
    calls.push({ state, meta });
    if (first) {
      first = false;
      await gate.promise; // stay busy while more commits land
    }
  });

  store.setState(1);
  await tick();
  assert.equal(calls.length, 1, 'first delivery in flight');
  assert.equal(calls[0].meta.version, 1);

  store.setState(2);
  store.setState(3);
  store.setState(4);
  await tick();
  assert.equal(calls.length, 1, 'busy observer is not re-entered');

  gate.resolve();
  await tick();

  assert.equal(calls.length, 2, 'coalesced into a single follow-up delivery');
  assert.equal(calls[1].state, 4, 'only the latest state is delivered');
  assert.deepEqual(calls[1].meta, {
    version: 4,
    skipped: { from: 2, to: 3 },
  });
});

test('unsubscribe waits for the in-flight callback to finish', async () => {
  const store = new ObservableStore(0);
  const gate = defer();
  const calls: number[] = [];

  const subscription = store.subscribe(async (state) => {
    calls.push(state);
    await gate.promise;
  });

  store.setState(1);
  await tick();
  assert.equal(calls.length, 1, 'callback in flight');

  let unsubscribed = false;
  const done = subscription.unsubscribe().then(() => {
    unsubscribed = true;
  });
  assert.equal(subscription.closed, true);

  await tick();
  assert.equal(unsubscribed, false, 'unsubscribe pending while callback runs');

  gate.resolve();
  await done;
  assert.equal(unsubscribed, true, 'resolves after the callback finished');

  store.setState(2);
  await tick();
  assert.deepEqual(calls, [1], 'no notifications after unsubscribe');
});

test('reentrant commits from inside a callback are delivered in order', async () => {
  const store = new ObservableStore(0);
  const gate = defer();
  const calls: Call<number>[] = [];

  store.subscribe(async (state, meta) => {
    calls.push({ state, meta });
    if (meta.version === 1) {
      store.setState(2); // reentrant commit while this callback runs
      await gate.promise;
    }
  });

  store.setState(1);
  await tick();
  assert.equal(calls.length, 1, 'second delivery waits for the first callback');

  gate.resolve();
  await tick();

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.meta.version),
    [1, 2],
    'versions delivered in commit order',
  );
  assert.deepEqual(calls[1].meta, { version: 2, skipped: null });
  assert.equal(calls[1].state, 2);
});

test('close() drops pending notifications and waits for in-flight callbacks', async () => {
  const store = new ObservableStore(0);
  const gate = defer();
  const calls: number[] = [];

  store.subscribe(async (state) => {
    calls.push(state);
    await gate.promise;
  });

  // Pending notification that has not been delivered yet.
  store.setState(1);
  const idle = new ObservableStore(0);
  const idleCalls: number[] = [];
  idle.subscribe((state) => {
    idleCalls.push(state);
  });
  idle.setState(1);
  await idle.close();
  await tick();
  assert.deepEqual(idleCalls, [], 'no notifications after close');

  // In-flight callback: close() waits for it.
  await tick();
  assert.deepEqual(calls, [1], 'first callback already running');
  store.setState(2);

  let closed = false;
  const closing = store.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false, 'close waits for the in-flight callback');
  assert.throws(() => store.setState(3), /closed/);

  gate.resolve();
  await closing;
  assert.equal(closed, true);
  assert.equal(store.isClosed, true);

  await tick();
  assert.deepEqual(calls, [1], 'no further notifications after close');
});
