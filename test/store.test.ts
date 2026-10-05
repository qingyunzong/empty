import test from "node:test";
import * as assert from "node:assert/strict";
import {
  ConflictError,
  StateStore,
  Transaction,
  TransactionClosedError,
  TransactionSettledError,
} from "../src/store.js";

/** A controllable latch used to pause a transaction mid-callback. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("commit applies staged writes atomically with a single version bump", async () => {
  const store = new StateStore();
  await store.set("outside", 1);
  const before = store.version;

  const result = await store.transaction(async (tx) => {
    await tx.set("a", 10);
    await tx.set("b", 20);
    await tx.delete("outside");
    return "done";
  });

  assert.equal(result, "done");
  assert.equal(await store.get("a"), 10);
  assert.equal(await store.get("b"), 20);
  assert.equal(await store.get("outside"), undefined);
  assert.equal(store.version, before + 1, "whole commit is one version bump");
});

test("transaction callback is awaitable and reads see own staged writes", async () => {
  const store = new StateStore();
  await store.set("k", "base");

  await store.transaction(async (tx) => {
    assert.equal(await tx.get("k"), "base");
    await tx.set("k", "staged");
    assert.equal(await tx.get("k"), "staged", "read-your-writes inside tx");
    await new Promise((r) => setTimeout(r, 10)); // async suspension point
    assert.equal(await tx.get("k"), "staged");
  });

  assert.equal(await store.get("k"), "staged");
});

test("external reads cannot see staged values while the transaction is pending", async () => {
  const store = new StateStore();
  await store.set("key", "original");

  const staged = deferred();
  const release = deferred();
  let leaked: unknown = "not-read";

  const pending = store.transaction(async (tx) => {
    await tx.set("key", "staged-value");
    staged.resolve(); // signal: staged write recorded, callback now waits
    await release.promise; // controllable wait: keep transaction open
  });

  await staged.promise;
  // While the transaction is suspended, the outside world must not observe it.
  leaked = await store.get("key");
  assert.equal(leaked, "original", "staged value must not leak to external reads");

  release.resolve();
  await pending;
  assert.equal(await store.get("key"), "staged-value", "value visible only after commit");
});

test("baseline version change makes the whole transaction conflict", async () => {
  const store = new StateStore();
  await store.set("x", 1);

  const staged = deferred();
  const release = deferred();

  const pending = store.transaction(async (tx) => {
    await tx.set("x", 999);
    await tx.set("y", 2);
    staged.resolve();
    await release.promise; // hold the transaction open
  });

  await staged.promise;
  await store.set("z", "concurrent-write"); // moves the baseline version
  release.resolve();

  await assert.rejects(pending, ConflictError);
  assert.equal(await store.get("x"), 1, "conflicting tx applies nothing");
  assert.equal(await store.get("y"), undefined, "staged key discarded entirely");
  assert.equal(await store.get("z"), "concurrent-write", "outside write survives");
});

test("saved transaction object forbids reads and writes after the callback returns", async () => {
  const store = new StateStore();
  let saved!: Transaction;

  await store.transaction(async (tx) => {
    await tx.set("k", "v");
    saved = tx;
  });

  assert.equal(saved.closed, true);
  await assert.rejects(() => saved.get("k"), TransactionClosedError);
  await assert.rejects(() => saved.set("k", "v2"), TransactionClosedError);
  await assert.rejects(() => saved.delete("k"), TransactionClosedError);
});

test("commit and cancel allow only one resolution", async () => {
  const store = new StateStore();

  // commit first: later cancel/commit must reject
  await store.transaction(async (tx) => {
    await tx.set("a", 1);
    await tx.commit();
    await assert.rejects(() => tx.cancel(), TransactionSettledError);
    await assert.rejects(() => tx.commit(), TransactionSettledError);
  });
  assert.equal(await store.get("a"), 1);

  // cancel first: later commit must reject and staged data is discarded
  await store.transaction(async (tx) => {
    await tx.set("b", 2);
    await tx.cancel();
    await assert.rejects(() => tx.commit(), TransactionSettledError);
    await assert.rejects(() => tx.cancel(), TransactionSettledError);
  });
  assert.equal(await store.get("b"), undefined, "cancelled tx leaves no trace");
});

test("cancel discards staged changes and leaves version untouched", async () => {
  const store = new StateStore();
  await store.set("keep", "me");
  const before = store.version;

  await store.transaction(async (tx) => {
    await tx.set("keep", "changed");
    await tx.set("extra", 1);
    await tx.cancel();
  });

  assert.equal(await store.get("keep"), "me");
  assert.equal(await store.get("extra"), undefined);
  assert.equal(store.version, before, "cancel must not bump the version");
});

test("throwing callback discards staged changes and rethrows", async () => {
  const store = new StateStore();
  await store.set("stable", 1);
  const before = store.version;
  const boom = new Error("boom");

  await assert.rejects(
    store.transaction(async (tx) => {
      await tx.set("stable", 2);
      throw boom;
    }),
    (err: unknown) => err === boom,
  );

  assert.equal(await store.get("stable"), 1);
  assert.equal(store.version, before);
});
