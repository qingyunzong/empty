import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ObservableStore,
  type SkippedRange,
  type Snapshot,
} from "../src/observable-store.js";

/** A manually resolvable promise used to control async timing in tests. */
interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flushes the microtask queue (notification delivery happens on microtasks). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("commit is synchronous, notification is asynchronous", async () => {
  const store = new ObservableStore(0);
  const seen: number[] = [];
  store.subscribe((s) => {
    seen.push(s.value);
  });

  const version = store.set(42);
  assert.equal(version, 1);
  assert.equal(store.getState(), 42, "state is committed synchronously");
  assert.equal(store.getVersion(), 1);
  assert.deepEqual(seen, [], "observer is not notified synchronously");

  await flushMicrotasks();
  assert.deepEqual(seen, [42], "observer is notified asynchronously");
  await store.close();
});

test("observer exception does not roll back state or block other observers", async () => {
  const errors: unknown[] = [];
  const store = new ObservableStore(0, {
    onObserverError: (e) => errors.push(e),
  });
  const boom = new Error("observer blew up");
  store.subscribe(() => {
    throw boom;
  });
  const seen: number[] = [];
  store.subscribe((s) => {
    seen.push(s.value);
  });

  store.set(7);
  await flushMicrotasks();

  assert.equal(store.getState(), 7, "committed state is kept");
  assert.deepEqual(seen, [7], "other observers are still notified");
  assert.deepEqual(errors, [boom], "error is routed to onObserverError");

  // The store keeps working after an observer failure.
  store.set(8);
  await flushMicrotasks();
  assert.equal(store.getState(), 8);
  assert.deepEqual(seen, [7, 8]);
  await store.close();
});

test("rejecting async observer is treated like a throwing observer", async () => {
  const errors: unknown[] = [];
  const store = new ObservableStore(0, {
    onObserverError: (e) => errors.push(e),
  });
  const boom = new Error("async failure");
  store.subscribe(async () => {
    throw boom;
  });
  store.set(1);
  await flushMicrotasks();
  assert.equal(store.getState(), 1);
  assert.deepEqual(errors, [boom]);
  await store.close();
});

test("slow observer receives only the latest version with the skipped range", async () => {
  const store = new ObservableStore(0);
  const gate = deferred();
  let firstCall = true;
  const snapshots: Snapshot<number>[] = [];
  store.subscribe(async (s) => {
    snapshots.push(s);
    if (firstCall) {
      firstCall = false;
      await gate.promise; // block the first callback while more commits land
    }
  });

  store.set(1);
  await flushMicrotasks(); // first notification is now in-flight and blocked
  store.set(2);
  store.set(3);
  store.set(4);
  await flushMicrotasks();
  assert.equal(snapshots.length, 1, "still blocked on the first callback");

  gate.resolve();
  await flushMicrotasks();

  assert.equal(snapshots.length, 2, "intermediate versions are coalesced");
  assert.equal(snapshots[0]!.version, 1);
  assert.equal(snapshots[0]!.skipped, null);
  assert.equal(snapshots[1]!.value, 4, "only the latest version is delivered");
  assert.equal(snapshots[1]!.version, 4);
  assert.deepEqual(
    snapshots[1]!.skipped,
    { from: 2, to: 3 } satisfies SkippedRange,
    "skipped range covers the superseded versions",
  );
  await store.close();
});

test("unsubscribe waits for the in-flight callback to finish", async () => {
  const store = new ObservableStore(0);
  const gate = deferred();
  const events: string[] = [];
  const sub = store.subscribe(async () => {
    events.push("callback:start");
    await gate.promise;
    events.push("callback:end");
  });

  store.set(1);
  await flushMicrotasks();
  assert.deepEqual(events, ["callback:start"], "callback is in-flight");

  let unsubscribed = false;
  const done = sub.unsubscribe().then(() => {
    unsubscribed = true;
  });
  assert.equal(sub.closed, true);
  await flushMicrotasks();
  assert.equal(unsubscribed, false, "unsubscribe waits for the callback");

  gate.resolve();
  await done;
  assert.equal(unsubscribed, true);
  assert.deepEqual(events, ["callback:start", "callback:end"]);

  store.set(2);
  await flushMicrotasks();
  assert.deepEqual(events, ["callback:start", "callback:end"], "no more notifications");
  await store.close();
});

test("reentrant update inside an observer is serialized, not nested", async () => {
  const store = new ObservableStore(0);
  const gate = deferred();
  const events: string[] = [];
  let reentered = false;

  store.subscribe(async (s) => {
    events.push(`enter:${s.version}`);
    if (!reentered) {
      reentered = true;
      await gate.promise; // hold the first callback, then update reentrantly
      store.update((n) => n + 1);
    }
    events.push(`exit:${s.version}`);
  });

  store.set(1);
  await flushMicrotasks();
  assert.deepEqual(events, ["enter:1"]);

  gate.resolve();
  await flushMicrotasks();

  assert.deepEqual(
    events,
    ["enter:1", "exit:1", "enter:2", "exit:2"],
    "reentrant commit is delivered after the current callback completes",
  );
  assert.equal(store.getState(), 2);
  assert.equal(store.getVersion(), 2);
  await store.close();
});

test("close waits for in-flight callbacks and no notifications happen afterwards", async () => {
  const store = new ObservableStore(0);
  const gate = deferred();
  const events: string[] = [];
  store.subscribe(async (s) => {
    events.push(`enter:${s.version}`);
    await gate.promise;
    events.push(`exit:${s.version}`);
  });

  store.set(1);
  await flushMicrotasks();
  assert.deepEqual(events, ["enter:1"], "callback is in-flight");

  store.set(2); // pending notification that must be dropped by close()
  let closed = false;
  const closing = store.close().then(() => {
    closed = true;
  });
  await flushMicrotasks();
  assert.equal(closed, false, "close waits for the in-flight callback");
  assert.equal(store.closed, true);

  gate.resolve();
  await closing;
  assert.equal(closed, true);
  assert.deepEqual(
    events,
    ["enter:1", "exit:1"],
    "pending notification for version 2 is never delivered",
  );

  assert.throws(() => store.set(3), /closed/);
  assert.throws(() => store.subscribe(() => undefined), /closed/);
  await flushMicrotasks();
  assert.deepEqual(events, ["enter:1", "exit:1"], "no notifications after close");
});

test("update computes from the latest committed state", async () => {
  const store = new ObservableStore(10);
  store.update((n) => n + 5);
  store.update((n) => n * 2);
  assert.equal(store.getState(), 30);
  assert.equal(store.getVersion(), 2);
  await store.close();
});
