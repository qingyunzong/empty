import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestCoalescer, abortError } from "../src/coalescer.js";
import { VirtualClock } from "../src/clock.js";
import { ManualExecutor } from "../src/testing.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("same-key concurrent fetches share one computation", async () => {
  const exec = new ManualExecutor<string>();
  const c = new RequestCoalescer(exec.compute);

  const a = c.fetch("k");
  const b = c.fetch("k");
  assert.equal(exec.callCount, 1);

  exec.lastCall().resolve("v1");
  assert.equal(await a.promise, "v1");
  assert.equal(await b.promise, "v1");

  const s = c.stats();
  console.log("stats:", s);
  assert.deepEqual(s, { calls: 1, joins: 1, failureCacheHits: 0, aborts: 0, staleSettlements: 0 });
});

test("different keys compute independently", async () => {
  const exec = new ManualExecutor<string>();
  const c = new RequestCoalescer(exec.compute);

  const a = c.fetch("k1");
  const b = c.fetch("k2");
  assert.equal(exec.callCount, 2);

  exec.calls[0]!.resolve("a");
  exec.calls[1]!.resolve("b");
  assert.equal(await a.promise, "a");
  assert.equal(await b.promise, "b");
  assert.equal(c.stats().joins, 0);
});

test("one waiter cancelling does not affect the others", async () => {
  const exec = new ManualExecutor<string>();
  const c = new RequestCoalescer(exec.compute);

  const a = c.fetch("k");
  const b = c.fetch("k");
  a.cancel();

  await assert.rejects(a.promise, (e) => e instanceof DOMException && e.name === "AbortError");
  assert.equal(exec.lastCall().signal.aborted, false, "computation must keep running");

  exec.lastCall().resolve("shared");
  assert.equal(await b.promise, "shared");
  assert.equal(c.stats().aborts, 0);
  assert.equal(exec.callCount, 1);
});

test("computation is aborted only when all waiters cancel", async () => {
  const exec = new ManualExecutor<string>();
  const c = new RequestCoalescer(exec.compute);

  const a = c.fetch("k");
  const b = c.fetch("k");
  a.cancel();
  assert.equal(exec.lastCall().signal.aborted, false);
  b.cancel();
  assert.equal(exec.lastCall().signal.aborted, true);

  await assert.rejects(a.promise);
  await assert.rejects(b.promise);
  assert.equal(c.stats().aborts, 1);
});

test("cancel then late resolve: stale generation is not resurrected", async () => {
  const exec = new ManualExecutor<string>();
  const c = new RequestCoalescer(exec.compute);

  const first = c.fetch("k");
  first.cancel();
  exec.lastCall().resolve("old-value");
  await assert.rejects(first.promise, (e) => e instanceof DOMException && e.name === "AbortError");
  await tick();

  const s1 = c.stats();
  console.log("stats:", s1);
  assert.equal(s1.staleSettlements, 1);

  const second = c.fetch("k");
  assert.equal(exec.callCount, 2, "old generation must not serve new fetches");
  exec.lastCall().resolve("new-value");
  assert.equal(await second.promise, "new-value");
});

test("resolve queued then last cancel in same tick: still no resurrection", async () => {
  const exec = new ManualExecutor<string>();
  const c = new RequestCoalescer(exec.compute);

  const first = c.fetch("k");
  exec.lastCall().resolve("old-value"); // settlement queued as microtask
  first.cancel(); // runs synchronously before the settlement handler
  await assert.rejects(first.promise, (e) => e instanceof DOMException && e.name === "AbortError");
  await tick();

  assert.equal(c.stats().staleSettlements, 1);
  const second = c.fetch("k");
  assert.equal(exec.callCount, 2);
  exec.lastCall().resolve("fresh");
  assert.equal(await second.promise, "fresh");
});

test("stale rejection after last cancel does not populate the failure cache", async () => {
  const clock = new VirtualClock();
  const exec = new ManualExecutor<string>();
  const c = new RequestCoalescer(exec.compute, { errorCacheMs: 1000, clock });

  const first = c.fetch("k");
  first.cancel();
  exec.lastCall().reject(abortError("aborted by coalescer"));
  await assert.rejects(first.promise, (e) => e instanceof DOMException && e.name === "AbortError");
  await tick();

  assert.equal(c.stats().staleSettlements, 1);
  const second = c.fetch("k");
  assert.equal(exec.callCount, 2, "stale failure must not be cached");
  assert.equal(c.stats().failureCacheHits, 0);
  exec.lastCall().resolve("ok");
  assert.equal(await second.promise, "ok");
});

test("failures are cached only for the specified virtual duration", async () => {
  const clock = new VirtualClock();
  const exec = new ManualExecutor<string>();
  const c = new RequestCoalescer(exec.compute, { errorCacheMs: 100, clock });
  const boom = new Error("boom");

  const first = c.fetch("k");
  exec.lastCall().reject(boom);
  await assert.rejects(first.promise, (e) => e === boom);

  const second = c.fetch("k");
  await assert.rejects(second.promise, (e) => e === boom);
  assert.equal(exec.callCount, 1, "cached failure must not recompute");

  clock.advance(50);
  const third = c.fetch("k");
  await assert.rejects(third.promise, (e) => e === boom);
  assert.equal(exec.callCount, 1, "still within the virtual TTL");

  clock.advance(51); // virtual now = 101 > expiresAt = 100
  const fourth = c.fetch("k");
  assert.equal(exec.callCount, 2, "cache expired: recompute");
  exec.lastCall().resolve("recovered");
  assert.equal(await fourth.promise, "recovered");

  const s = c.stats();
  console.log("stats:", s);
  assert.equal(s.failureCacheHits, 2);
  assert.equal(s.calls, 2);
});

test("successes are not cached; each later fetch recomputes", async () => {
  const exec = new ManualExecutor<string>();
  const c = new RequestCoalescer(exec.compute, { errorCacheMs: 100 });

  const first = c.fetch("k");
  exec.lastCall().resolve("one");
  assert.equal(await first.promise, "one");

  const second = c.fetch("k");
  assert.equal(exec.callCount, 2);
  exec.lastCall().resolve("two");
  assert.equal(await second.promise, "two");
});

test("cancelling after settlement is a no-op", async () => {
  const exec = new ManualExecutor<string>();
  const c = new RequestCoalescer(exec.compute);

  const h = c.fetch("k");
  exec.lastCall().resolve("v");
  assert.equal(await h.promise, "v");
  h.cancel();
  assert.equal(c.stats().aborts, 0);
});
