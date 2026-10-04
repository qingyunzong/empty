import { test } from "node:test";
import assert from "node:assert/strict";
import { VersionedStore, Subscription, Message } from "../src/index.js";

type State = { count: number };
type Delta = { by: number };
type Msg = Message<State, Delta>;

function makeStore(options: { maxLog?: number; snapshotDelayMs?: number } = {}) {
  return new VersionedStore<State, Delta>({ count: 0 }, options);
}

function inc(store: VersionedStore<State, Delta>, by = 1): number {
  return store.update((s) => {
    s.count += by;
    return { by };
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function nextMsg(
  iter: AsyncIterator<Msg>,
  timeoutMs = 2000,
): Promise<Msg> {
  let timer: unknown;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
  });
  try {
    const result = await Promise.race([iter.next(), timeout]);
    if (result.done) throw new Error("subscription ended unexpectedly");
    return result.value;
  } finally {
    clearTimeout(timer);
  }
}

function expectNoMessage(
  iter: AsyncIterator<Msg>,
  withinMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, withinMs);
    void iter.next().then((result) => {
      clearTimeout(timer);
      if (result.done) {
        resolve();
      } else {
        reject(new Error(`unexpected message after close: ${JSON.stringify(result.value)}`));
      }
    }, reject);
  });
}

test("snapshot is sent first; deltas arriving during the snapshot are appended after it, consecutive", async () => {
  const store = makeStore({ snapshotDelayMs: 30 });
  const sub = store.subscribe();
  const iter = sub[Symbol.asyncIterator]();

  // These land while the snapshot promise is still in flight.
  inc(store, 1);
  inc(store, 2);
  inc(store, 3);

  const first = await nextMsg(iter);
  if (first.type !== "snapshot") assert.fail(`expected snapshot, got ${first.type}`);
  assert.equal(first.version, 0);
  assert.deepEqual(first.state, { count: 0 });

  const expected = [1, 2, 3];
  for (const version of expected) {
    const msg = await nextMsg(iter);
    if (msg.type !== "delta") assert.fail(`expected delta, got ${msg.type}`);
    assert.equal(msg.version, version);
    assert.equal(msg.delta.by, version);
  }
  await sub.close();
});

test("buffer overflow triggers explicit resync instead of silently skipping versions", async () => {
  const store = makeStore();
  const sub = store.subscribe({ maxBuffer: 3 });
  const iter = sub[Symbol.asyncIterator]();

  const snap = await nextMsg(iter);
  assert.equal(snap.type, "snapshot");

  // Slow consumer: stop reading while 10 updates arrive.
  for (let i = 0; i < 10; i++) inc(store);

  const msg = await nextMsg(iter);
  if (msg.type !== "resync") assert.fail(`expected resync, got ${msg.type}`);
  assert.equal(msg.version, 10);
  assert.deepEqual(msg.state, { count: 10 });

  // The stream continues consecutively from the resync point.
  inc(store);
  inc(store);
  const d11 = await nextMsg(iter);
  const d12 = await nextMsg(iter);
  assert.equal(d11.type, "delta");
  assert.equal(d11.version, 11);
  assert.equal(d12.type, "delta");
  assert.equal(d12.version, 12);
  await sub.close();
});

test("shared log trimmed past a starting subscriber forces explicit resync", async () => {
  const store = makeStore({ maxLog: 4, snapshotDelayMs: 30 });
  const sub = store.subscribe();
  const iter = sub[Symbol.asyncIterator]();

  // 10 updates during the snapshot window; the log only retains the last 4.
  for (let i = 0; i < 10; i++) inc(store);

  const msg = await nextMsg(iter);
  if (msg.type !== "resync") assert.fail(`expected resync, got ${msg.type}`);
  assert.equal(msg.version, 10);
  assert.deepEqual(msg.state, { count: 10 });

  inc(store);
  const d11 = await nextMsg(iter);
  assert.equal(d11.type, "delta");
  assert.equal(d11.version, 11);
  await sub.close();
});

test("close interleaved with snapshot resolution never resurrects the subscription", async () => {
  for (let i = 0; i < 50; i++) {
    const store = makeStore({ snapshotDelayMs: 5 });
    const sub = store.subscribe();
    const received: Msg[] = [];
    const reader = (async () => {
      for await (const msg of sub) received.push(msg);
    })();

    // Close at a randomized point around the snapshot resolution time.
    await sleep(Math.floor(Math.random() * 12));
    await sub.close();
    await reader;

    assert.ok(sub.closed);
    assert.equal(store.subscriberCount, 0);

    // The snapshot promise (if still pending at close time) has settled by
    // now; further updates must reach nobody and emit nothing.
    const seen = received.length;
    inc(store);
    await sleep(20);
    assert.equal(received.length, seen);
    assert.equal(store.subscriberCount, 0);

    // Any snapshot that was delivered must have been the first message.
    for (const msg of received) {
      assert.equal(msg, received[0]);
      break;
    }
    if (received.length > 0) assert.equal(received[0]!.type, "snapshot");
  }
});

test("close before a zero-delay snapshot resolves emits nothing", async () => {
  const store = makeStore({ snapshotDelayMs: 0 });
  const sub = store.subscribe();
  const iter = sub[Symbol.asyncIterator]();
  await sub.close(); // snapshot promise resolves on a later microtask
  assert.ok(sub.closed);
  assert.equal(store.subscriberCount, 0);
  inc(store);
  await expectNoMessage(iter, 30);
});

test("reentrant updates keep versions consecutive and in order", async () => {
  const store = makeStore();
  // Reentrancy from an update listener: version 1 triggers version 2.
  store.onUpdate((version) => {
    if (version === 1) inc(store, 100);
  });
  const sub = store.subscribe();
  const iter = sub[Symbol.asyncIterator]();

  const snap = await nextMsg(iter);
  assert.equal(snap.type, "snapshot");
  assert.equal(snap.version, 0);

  inc(store, 1);

  const d1 = await nextMsg(iter);
  assert.equal(d1.type, "delta");
  assert.equal(d1.version, 1);
  const d2 = await nextMsg(iter);
  assert.equal(d2.type, "delta");
  assert.equal(d2.version, 2);
  if (d2.type === "delta") assert.deepEqual(d2.delta, { by: 100 });

  // Reentrancy from within message consumption: update before reading on.
  inc(store, 5);
  const d3 = await nextMsg(iter);
  assert.equal(d3.type, "delta");
  assert.equal(d3.version, 3);

  assert.equal(store.currentVersion, 3);
  await sub.close();
});

test("slow consumer receives every delta, consecutive and in order", async () => {
  const store = makeStore();
  const sub = store.subscribe({ maxBuffer: 1000 });
  const iter = sub[Symbol.asyncIterator]();

  const snap = await nextMsg(iter);
  assert.equal(snap.type, "snapshot");

  const total = 50;
  for (let i = 0; i < total; i++) inc(store);

  for (let version = 1; version <= total; version++) {
    const msg = await nextMsg(iter);
    await sleep(2); // simulate slow processing
    assert.equal(msg.type, "delta");
    assert.equal(msg.version, version);
  }
  await sub.close();
});

test("subscribers are independent: a slow peer does not affect a fast one", async () => {
  const store = makeStore();
  const fast = store.subscribe();
  const slow = store.subscribe({ maxBuffer: 2 });
  const fastIter = fast[Symbol.asyncIterator]();
  const slowIter = slow[Symbol.asyncIterator]();

  assert.equal((await nextMsg(fastIter)).type, "snapshot");
  assert.equal((await nextMsg(slowIter)).type, "snapshot");

  for (let i = 0; i < 6; i++) inc(store);

  // Fast subscriber drains everything, consecutive.
  for (let version = 1; version <= 6; version++) {
    const msg = await nextMsg(fastIter);
    assert.equal(msg.type, "delta");
    assert.equal(msg.version, version);
  }
  // Slow subscriber overflowed its tiny buffer and resynced explicitly.
  const msg = await nextMsg(slowIter);
  if (msg.type !== "resync") assert.fail(`expected resync, got ${msg.type}`);
  assert.equal(msg.version, 5);
  assert.deepEqual(msg.state, { count: 5 });
  // ...and continues consecutively from the resync point.
  const d6 = await nextMsg(slowIter);
  assert.equal(d6.type, "delta");
  assert.equal(d6.version, 6);

  await fast.close();
  await slow.close();
  assert.equal(store.subscriberCount, 0);
});
