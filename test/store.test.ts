import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConflictError,
  Store,
  Transaction,
  TransactionClosedError,
} from '../src/store.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('transaction callback is awaitable and staged writes commit after it returns', async () => {
  const store = new Store();
  store.set('a', 1);

  const result = await store.transaction(async (tx) => {
    tx.set('a', 2);
    tx.set('b', 3);
    await Promise.resolve();
    return 'done';
  });

  assert.equal(result, 'done');
  assert.equal(store.get('a'), 2);
  assert.equal(store.get('b'), 3);
});

test('staged writes are invisible to external readers while the transaction is held open', async () => {
  const store = new Store();
  store.set('k', 'committed');

  const gate = deferred();
  const txPromise = store.transaction(async (tx) => {
    tx.set('k', 'staged');
    await gate.promise;
  });

  await new Promise((r) => setImmediate(r));
  assert.equal(store.get('k'), 'committed', 'external read must not see staged value');

  gate.resolve();
  await txPromise;
  assert.equal(store.get('k'), 'staged', 'value becomes visible after commit');
});

test('tx.get reads own staged writes and falls back to committed values', async () => {
  const store = new Store();
  store.set('x', 'committed-x');

  await store.transaction((tx) => {
    tx.set('y', 'staged-y');
    assert.equal(tx.get('y'), 'staged-y');
    assert.equal(tx.get('x'), 'committed-x');
  });
});

test('baseline version change causes whole-transaction conflict, nothing is applied', async () => {
  const store = new Store();
  store.set('p', 'p0');
  store.set('q', 'q0');

  const gate = deferred();
  const txPromise = store.transaction(async (tx) => {
    tx.set('p', 'p1');
    tx.set('q', 'q1');
    await gate.promise;
  });

  await new Promise((r) => setImmediate(r));
  store.set('p', 'external');

  gate.resolve();
  await assert.rejects(txPromise, ConflictError);
  assert.equal(store.get('p'), 'external');
  assert.equal(store.get('q'), 'q0', 'no partial application on conflict');
});

test('cancel and commit allow only one resolution: cancel first, commit fails', async () => {
  const store = new Store();

  await store.transaction(async (tx) => {
    tx.set('k', 'staged');
    tx.cancel();
    await assert.rejects(tx.commit(), TransactionClosedError);
  });

  assert.equal(store.get('k'), undefined, 'cancelled transaction applies nothing');
});

test('cancel and commit allow only one resolution: commit first, cancel fails', async () => {
  const store = new Store();

  await store.transaction(async (tx) => {
    tx.set('k', 'v');
    await tx.commit();
    assert.throws(() => tx.cancel(), TransactionClosedError);
  });

  assert.equal(store.get('k'), 'v');
});

test('a failed commit (conflict) settles the transaction; cancel afterwards fails', async () => {
  const store = new Store();
  store.set('k', 'v0');

  const gate = deferred();
  let saved: Transaction | undefined;
  const txPromise = store.transaction(async (tx) => {
    saved = tx;
    tx.set('k', 'v1');
    await gate.promise;
    store.set('k', 'external');
    await assert.rejects(tx.commit(), ConflictError);
    assert.throws(() => tx.cancel(), TransactionClosedError);
    throw new ConflictError();
  });

  await new Promise((r) => setImmediate(r));
  gate.resolve();
  await assert.rejects(txPromise, ConflictError);
  assert.ok(saved);
});

test('transaction object saved after callback returns forbids reads and writes', async () => {
  const store = new Store();
  let saved: Transaction | undefined;

  await store.transaction((tx) => {
    tx.set('k', 'v');
    saved = tx;
  });

  assert.ok(saved);
  const tx = saved;
  assert.throws(() => tx.get('k'), TransactionClosedError);
  assert.throws(() => tx.set('k', 'x'), TransactionClosedError);
  assert.throws(() => tx.cancel(), TransactionClosedError);
  await assert.rejects(tx.commit(), TransactionClosedError);
});

test('throwing callback rejects the transaction and applies nothing', async () => {
  const store = new Store();
  store.set('k', 'v0');
  const boom = new Error('boom');

  await assert.rejects(
    store.transaction((tx) => {
      tx.set('k', 'v1');
      throw boom;
    }),
    (err: unknown) => err === boom,
  );
  assert.equal(store.get('k'), 'v0');
});

test('version only advances on committed writes', async () => {
  const store = new Store();
  assert.equal(store.version, 0);

  await store.transaction((tx) => {
    tx.set('a', 1);
  });
  assert.equal(store.version, 1);

  await store.transaction((tx) => {
    tx.set('a', 2);
    tx.cancel();
  });
  assert.equal(store.version, 1, 'cancelled transaction does not bump version');
});
