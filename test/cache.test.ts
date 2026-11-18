import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MISS,
  MemoryL1Store,
  MemoryL2Store,
  MultiLevelCache,
  OrderedInvalidationBus,
  type InvalidationEvent,
} from "../src/index.js";
import {
  ControlledLoader,
  GatedL2Store,
  VirtualClock,
  flushMicrotasks,
  valueOf,
} from "./helpers.js";

describe("MultiLevelCache", () => {
  it("coalesces a burst of cold loads into one source fetch and caches it", async () => {
    const clock = new VirtualClock();
    const loader = new ControlledLoader<string>();
    const l2 = new MemoryL2Store<string, string>();
    const cache = new MultiLevelCache<string, string>({
      loader: loader.load,
      ttlMs: 1_000,
      now: clock.now,
      l2,
    });

    const first = cache.getDetailed("a");
    const second = cache.getDetailed("a");
    const third = cache.getDetailed("a");
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(loader.callsFor("a"), 1);
    assert.equal(loader.pendingFor("a"), 1);
    assert.equal(loader.resolve("a", "A"), 1);

    const results = await Promise.all([first, second, third]);
    assert.deepEqual(
      results.map((result) => result.value),
      ["A", "A", "A"],
    );
    assert.deepEqual(
      results.map((result) => result.source),
      ["loader", "single-flight", "single-flight"],
    );

    const stats = cache.statsFor("a");
    assert.equal(stats.loads, 1);
    assert.equal(stats.coalesced, 2);
    assert.equal(l2.writesFor("a"), 1);

    const again = await cache.getDetailed("a");
    assert.equal(again.source, "l1");
    assert.equal(again.value, "A");
    assert.equal(loader.callsFor("a"), 1);
  });

  it("serves L2 after L1 loss, promotes it, and invalidates exactly one key", async () => {
    const clock = new VirtualClock();
    const loader = new ControlledLoader<string>();
    const l1 = new MemoryL1Store<string, string>();
    const l2 = new MemoryL2Store<string, string>();
    const cache = new MultiLevelCache<string, string>({
      loader: loader.load,
      ttlMs: 1_000,
      now: clock.now,
      l1,
      l2,
    });

    const load = cache.getDetailed("a");
    const loadOther = cache.getDetailed("b");
    await flushMicrotasks();
    loader.resolve("a", "A");
    loader.resolve("b", "B");
    await Promise.all([load, loadOther]);

    assert.equal(l1.get("a")?.kind, "value");
    assert.equal(l1.get("b")?.kind, "value");

    l1.delete("a");
    const fromL2 = await cache.getDetailed("a");
    assert.equal(fromL2.source, "l2");
    assert.equal(fromL2.value, "A");
    assert.equal(l1.get("a")?.kind, "value", "L2 hit is promoted to L1");

    await cache.invalidate("a");
    assert.equal(l1.get("a"), undefined);
    assert.equal(l2.get("a"), undefined);
    assert.equal(l1.get("b")?.kind, "value");
    assert.equal(l2.get("b")?.kind, "value");

    const reload = cache.getDetailed("a");
    await flushMicrotasks();
    assert.equal(loader.callsFor("a"), 2);
    loader.resolve("a", "A2");
    const result = await reload;
    assert.equal(result.source, "loader");
    assert.equal(result.value, "A2");
  });

  it("keeps negative entries under an independent TTL", async () => {
    const clock = new VirtualClock();
    const loader = new ControlledLoader<string>();
    const cache = new MultiLevelCache<string, string>({
      loader: loader.load,
      ttlMs: 1_000,
      negativeTtlMs: 100,
      now: clock.now,
    });

    const cold = cache.getDetailed("missing");
    const coldPositive = cache.getDetailed("present");
    await flushMicrotasks();
    loader.resolve("missing", MISS);
    loader.resolve("present", "value");
    const [negative, positive] = await Promise.all([cold, coldPositive]);
    assert.equal(negative.negative, true);
    assert.equal(negative.value, undefined);
    assert.equal(negative.expiresAt, 100);
    assert.equal(positive.expiresAt, 1_000);

    const hit = await cache.getDetailed("missing");
    assert.equal(hit.source, "l1");
    assert.equal(hit.negative, true);
    assert.equal(loader.callsFor("missing"), 1);
    assert.equal(cache.statsFor("missing").negativeHits, 1);

    clock.advance(99);
    assert.equal((await cache.getDetailed("missing")).negative, true);
    assert.equal(loader.callsFor("missing"), 1);

    clock.advance(1);
    const expired = cache.getDetailed("missing");
    await flushMicrotasks();
    assert.equal(loader.callsFor("missing"), 2);
    loader.resolve("missing", "now-present");
    const refreshed = await expired;
    assert.equal(refreshed.negative, false);
    assert.equal(refreshed.value, "now-present");

    // The positive entry is unaffected by the shorter negative TTL.
    assert.equal((await cache.getDetailed("present")).value, "value");
    assert.equal(loader.callsFor("present"), 1);
  });

  it("applies deterministic TTL jitter from an injected random source", async () => {
    const clock = new VirtualClock();
    const loader = new ControlledLoader<string>();
    const samples = [0, 1, 0.5, 0];
    let sampleIndex = 0;
    const cache = new MultiLevelCache<string, string>({
      loader: loader.load,
      ttlMs: 1_000,
      negativeTtlMs: 200,
      ttlJitter: 0.2,
      now: clock.now,
      random: () => samples[sampleIndex++] ?? 0.5,
    });

    const requests = [
      cache.getDetailed("a"),
      cache.getDetailed("b"),
      cache.getDetailed("c"),
      cache.getDetailed("d"),
    ];
    await flushMicrotasks();
    loader.resolve("a", "A");
    loader.resolve("b", "B");
    loader.resolve("c", "C");
    loader.resolve("d", MISS);
    const [a, b, c, d] = await Promise.all(requests);

    assert.equal(a.expiresAt, 800);
    assert.equal(b.expiresAt, 1_200);
    assert.equal(c.expiresAt, 1_000);
    assert.equal(d.expiresAt, 160);
    assert.equal(d.negative, true);
  });

  it("shares loader failures across the single-flight group and retries later", async () => {
    const clock = new VirtualClock();
    const loader = new ControlledLoader<string>();
    const cache = new MultiLevelCache<string, string>({
      loader: loader.load,
      ttlMs: 1_000,
      now: clock.now,
    });

    const first = cache.getDetailed("a");
    const second = cache.getDetailed("a");
    await flushMicrotasks();
    loader.reject("a", new Error("boom"));
    await assert.rejects(first, /boom/);
    await assert.rejects(second, /boom/);

    assert.equal(cache.statsFor("a").loadFailures, 1);
    assert.equal(cache.statsFor("a").coalesced, 1);

    const retry = cache.getDetailed("a");
    await flushMicrotasks();
    assert.equal(loader.callsFor("a"), 2);
    loader.resolve("a", "recovered");
    assert.equal((await retry).value, "recovered");
  });

  it("broadcasts exact-key invalidations in order and rejects stale duplicates", async () => {
    const bus = new OrderedInvalidationBus<string>();
    const events: InvalidationEvent<string>[] = [];
    bus.subscribe((event) => {
      events.push(event);
    });

    const loaderA = new ControlledLoader<string>();
    const loaderB = new ControlledLoader<string>();
    const cacheA = new MultiLevelCache<string, string>({
      loader: loaderA.load,
      ttlMs: 1_000,
      invalidation: bus,
      origin: "origin-a",
    });
    const cacheB = new MultiLevelCache<string, string>({
      loader: loaderB.load,
      ttlMs: 1_000,
      invalidation: bus,
      origin: "origin-b",
    });

    const aLoad = cacheA.getDetailed("x");
    const bLoad = cacheA.getDetailed("y");
    await flushMicrotasks();
    loaderA.resolve("x", "X");
    loaderA.resolve("y", "Y");
    await Promise.all([aLoad, bLoad]);

    // Prime the remote cache's L2 with the same values through its own loader.
    const remoteX = cacheB.getDetailed("x");
    const remoteY = cacheB.getDetailed("y");
    await flushMicrotasks();
    loaderB.resolve("x", "X");
    loaderB.resolve("y", "Y");
    await Promise.all([remoteX, remoteY]);

    await Promise.all([
      cacheA.invalidate("x"),
      cacheA.invalidate("y"),
      cacheA.invalidate("x"),
    ]);
    await bus.idle();

    assert.deepEqual(
      events.map((event) => event.key),
      ["x", "y", "x"],
    );
    assert.deepEqual(
      events.map((event) => event.version),
      [1, 1, 2],
    );
    assert.equal(await cacheB.peek("x"), undefined);
    assert.equal(await cacheB.peek("y"), undefined);
    assert.equal(cacheB.statsFor("x").invalidations, 2);

    // Duplicate and per-origin out-of-order events are ignored.
    await cacheB.applyInvalidation({ key: "x", version: 2, origin: "origin-a" });
    await cacheB.applyInvalidation({ key: "x", version: 1, origin: "origin-a" });
    assert.equal(cacheB.statsFor("x").invalidations, 2);
    assert.equal(loaderB.callsFor("x"), 1);
  });

  it("does not write back an in-flight load that was invalidated before it resolved", async () => {
    const clock = new VirtualClock();
    const loader = new ControlledLoader<string>();
    const l1 = new MemoryL1Store<string, string>();
    const l2 = new MemoryL2Store<string, string>();
    const cache = new MultiLevelCache<string, string>({
      loader: loader.load,
      ttlMs: 1_000,
      now: clock.now,
      l1,
      l2,
    });

    const oldRequest = cache.getDetailed("a");
    await flushMicrotasks();
    assert.equal(loader.pendingFor("a"), 1);

    await cache.invalidate("a");
    const newRequest = cache.getDetailed("a");
    await flushMicrotasks();
    assert.equal(loader.callsFor("a"), 2);
    assert.equal(loader.pendingFor("a"), 2);

    loader.resolveWith("a", (id) => `A${id}`);
    const [oldResult, newResult] = await Promise.all([oldRequest, newRequest]);
    assert.equal(oldResult.value, "A1");
    assert.equal(newResult.value, "A2");

    // Only the post-invalidation generation may populate the cache.
    assert.equal(l1.get("a")?.kind, "value");
    assert.equal(valueOf(l1.get("a")), "A2");
    assert.equal(valueOf(l2.get("a")), "A2");
    assert.equal(l2.writesFor("a"), 1);
    assert.equal(cache.statsFor("a").staleWritesRejected, 1);

    const cached = await cache.getDetailed("a");
    assert.equal(cached.source, "l1");
    assert.equal(cached.value, "A2");
    assert.equal(loader.callsFor("a"), 2);
  });

  it("fences a write that races with invalidation while L2.set is blocked", async () => {
    const clock = new VirtualClock();
    const loader = new ControlledLoader<string>();
    const l1 = new MemoryL1Store<string, string>();
    const l2 = new GatedL2Store<string, string>();
    const cache = new MultiLevelCache<string, string>({
      loader: loader.load,
      ttlMs: 1_000,
      now: clock.now,
      l1,
      l2,
    });

    l2.armSetGate();
    const request = cache.getDetailed("a");
    await flushMicrotasks();
    loader.resolve("a", "stale");
    await l2.waitForSetToStart();

    const invalidation = cache.invalidate("a");
    l2.releaseSetWrite();
    const result = await request;
    await invalidation;
    assert.equal(result.value, "stale", "the original caller still gets its result");

    assert.equal(l1.get("a"), undefined);
    assert.equal(await l2.get("a"), undefined);
    assert.equal(l2.sets, 1);
    assert.equal(cache.statsFor("a").staleWritesRejected, 1);

    const fresh = cache.getDetailed("a");
    await flushMicrotasks();
    assert.equal(loader.callsFor("a"), 2);
    loader.resolve("a", "fresh");
    assert.equal((await fresh).value, "fresh");
  });

  it("does not read an L2 entry while its invalidation delete is still pending", async () => {
    const clock = new VirtualClock();
    const loader = new ControlledLoader<string>();
    const l1 = new MemoryL1Store<string, string>();
    const l2 = new MemoryL2Store<string, string>();
    const cache = new MultiLevelCache<string, string>({
      loader: loader.load,
      ttlMs: 1_000,
      now: clock.now,
      l1,
      l2,
    });

    const prime = cache.getDetailed("a");
    await flushMicrotasks();
    loader.resolve("a", "old");
    await prime;
    l1.delete("a");

    // Invalidate without awaiting: the L1 entry disappears synchronously but
    // the L2 delete is asynchronous. The following read must not observe it.
    const invalidation = cache.invalidate("a");
    const read = cache.getDetailed("a");
    await flushMicrotasks();
    assert.equal(loader.callsFor("a"), 2);
    loader.resolve("a", "new");
    const [result] = await Promise.all([read, invalidation]);
    assert.equal(result.source, "loader");
    assert.equal(result.value, "new");
  });

  it("applies a remote invalidation as a barrier before the next read", async () => {
    const clock = new VirtualClock();
    const loader = new ControlledLoader<string>();
    const l1 = new MemoryL1Store<string, string>();
    const l2 = new MemoryL2Store<string, string>();
    const cache = new MultiLevelCache<string, string>({
      loader: loader.load,
      ttlMs: 1_000,
      now: clock.now,
      l1,
      l2,
      origin: "local",
    });

    const prime = cache.getDetailed("a");
    await flushMicrotasks();
    loader.resolve("a", "old");
    await prime;
    l1.delete("a");

    const remote = cache.applyInvalidation({ key: "a", version: 1, origin: "remote" });
    const read = cache.getDetailed("a");
    await flushMicrotasks();
    assert.equal(loader.callsFor("a"), 2);
    loader.resolve("a", "new");
    assert.equal((await read).value, "new");
    await remote;
  });

  it("waits for a queued invalidation delete before writing a new generation", async () => {
    const clock = new VirtualClock();
    const l1 = new MemoryL1Store<string, string>();
    const l2 = new GatedL2Store<string, string>();
    let releaseBlockedPublish!: () => void;
    const blockedPublish = new Promise<void>((resolve) => {
      releaseBlockedPublish = resolve;
    });
    const transport = {
      publish(event: InvalidationEvent<string>): Promise<void> {
        return event.key === "z" ? blockedPublish : Promise.resolve();
      },
      subscribe(): () => void {
        return () => undefined;
      },
    };
    const cache = new MultiLevelCache<string, string>({
      loader: async (key) => `${key}-fresh`,
      ttlMs: 1_000,
      now: clock.now,
      l1,
      l2,
      invalidation: transport,
      origin: "local",
    });

    l2.inner.set("a", { kind: "value", value: "old", expiresAt: 1_000 });
    l2.armGetGate();
    const pendingRead = cache.getDetailed("a");
    await l2.waitForGetToStart();

    // "z" blocks the ordered invalidation queue, so "a"'s L2 delete has not
    // run yet even though its generation was already bumped.
    const invalidateZ = cache.invalidate("z");
    const invalidateA = cache.invalidate("a");
    l2.releaseGetRead();
    await flushMicrotasks();

    // The read must not start a fresh flight (and therefore cannot write)
    // until the queued delete for "a" has completed.
    assert.equal(l2.sets, 0);
    releaseBlockedPublish();
    const result = await pendingRead;
    await Promise.all([invalidateZ, invalidateA]);

    assert.equal(result.source, "loader");
    assert.equal(result.value, "a-fresh");
    assert.equal(valueOf(l1.get("a")), "a-fresh");
    assert.equal(valueOf(l2.inner.get("a")), "a-fresh");
  });
});
