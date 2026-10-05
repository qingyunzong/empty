import { test } from "node:test";
import assert from "node:assert/strict";
import { PromiseCache } from "../src/promise-cache.js";

interface Deferred<V> {
  promise: Promise<V>;
  resolve: (value: V) => void;
  reject: (reason: unknown) => void;
}

function deferred<V>(): Deferred<V> {
  let resolve!: (value: V) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<V>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued microtasks (settle handlers) run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A loader whose every call returns a fresh controllable promise. */
class ControllableLoader {
  readonly calls: string[] = [];
  private readonly pending = new Map<string, Deferred<string>[]>();

  loader = (key: string): Promise<string> => {
    this.calls.push(key);
    const d = deferred<string>();
    const list = this.pending.get(key) ?? [];
    list.push(d);
    this.pending.set(key, list);
    return d.promise;
  };

  /** Resolves the `n`-th (0-based) task created for `key`. */
  resolve(key: string, n: number, value: string): void {
    const task = this.pending.get(key)?.[n];
    if (!task) throw new Error(`no task ${n} for key ${key}`);
    task.resolve(value);
  }

  reject(key: string, n: number, reason: unknown): void {
    const task = this.pending.get(key)?.[n];
    if (!task) throw new Error(`no task ${n} for key ${key}`);
    task.reject(reason);
  }
}

test("in-flight requests for the same key share one task", async () => {
  const loader = new ControllableLoader();
  const cache = new PromiseCache<string, string>(2, loader.loader);

  const p1 = cache.get("a");
  const p2 = cache.get("a");
  assert.strictEqual(p1, p2);
  assert.deepStrictEqual(loader.calls, ["a"]);

  loader.resolve("a", 0, "A");
  assert.strictEqual(await p1, "A");
  assert.strictEqual(await p2, "A");
});

test("LRU: touching a key protects it; the least-recently-used key is evicted", () => {
  const loader = new ControllableLoader();
  const cache = new PromiseCache<string, string>(2, loader.loader);

  cache.get("a");
  cache.get("b");
  cache.get("a"); // touch: order becomes b (LRU), a (MRU)
  cache.get("c"); // exceeds capacity -> evicts b, not a

  assert.strictEqual(cache.size, 2);
  assert.strictEqual(cache.has("a"), true);
  assert.strictEqual(cache.has("b"), false);
  assert.strictEqual(cache.has("c"), true);
  assert.deepStrictEqual(loader.calls, ["a", "b", "c"]);
});

test("eviction does not cancel existing waiters", async () => {
  const loader = new ControllableLoader();
  const cache = new PromiseCache<string, string>(1, loader.loader);

  const evictedPromise = cache.get("a");
  cache.get("b"); // evicts a
  assert.strictEqual(cache.has("a"), false);

  loader.resolve("a", 0, "late-A");
  assert.strictEqual(await evictedPromise, "late-A");
});

test("late result of an evicted generation is not re-inserted", async () => {
  const loader = new ControllableLoader();
  const cache = new PromiseCache<string, string>(2, loader.loader);

  cache.get("a");
  cache.get("b");
  cache.get("c"); // evicts a
  assert.strictEqual(cache.has("a"), false);

  loader.resolve("a", 0, "late-A"); // a settles after being evicted
  await flush();

  assert.strictEqual(cache.has("a"), false);
  assert.strictEqual(cache.size, 2);
  assert.strictEqual(cache.has("b"), true);
  assert.strictEqual(cache.has("c"), true);
});

test("failure deletes the entry; the next request creates a new task", async () => {
  const loader = new ControllableLoader();
  const cache = new PromiseCache<string, string>(2, loader.loader);

  const p1 = cache.get("a");
  const boom = new Error("boom");
  loader.reject("a", 0, boom);
  await assert.rejects(p1, boom);
  await flush();

  assert.strictEqual(cache.has("a"), false);
  assert.strictEqual(cache.size, 0);

  const p2 = cache.get("a"); // retry -> brand-new task
  assert.deepStrictEqual(loader.calls, ["a", "a"]);
  loader.resolve("a", 1, "A2");
  assert.strictEqual(await p2, "A2");
});

test("success also removes the entry (in-flight cache); re-request creates a new task", async () => {
  const loader = new ControllableLoader();
  const cache = new PromiseCache<string, string>(2, loader.loader);

  const p1 = cache.get("a");
  loader.resolve("a", 0, "A1");
  assert.strictEqual(await p1, "A1");
  await flush();

  assert.strictEqual(cache.has("a"), false);
  cache.get("a");
  assert.deepStrictEqual(loader.calls, ["a", "a"]);
});

test("generation isolation: re-request after eviction creates a new task; late old result cannot displace it", async () => {
  const loader = new ControllableLoader();
  const cache = new PromiseCache<string, string>(1, loader.loader);

  const gen0 = cache.get("a"); // generation 0
  cache.get("b"); // evicts generation 0 of a
  const gen1 = cache.get("a"); // same key again -> NEW task (generation 1)

  assert.notStrictEqual(gen0, gen1);
  assert.deepStrictEqual(loader.calls, ["a", "b", "a"]);

  // The evicted generation settles late: must not delete or replace gen1.
  loader.resolve("a", 0, "old-A");
  assert.strictEqual(await gen0, "old-A");
  await flush();

  assert.strictEqual(cache.has("a"), true); // gen1 still cached
  assert.strictEqual(cache.size, 1);

  // gen1 settles normally and is then released.
  loader.resolve("a", 1, "new-A");
  assert.strictEqual(await gen1, "new-A");
  await flush();
  assert.strictEqual(cache.has("a"), false);
});

test("a synchronous throw from the loader becomes a rejection and frees the entry", async () => {
  let calls = 0;
  const cache = new PromiseCache<string, string>(2, () => {
    calls++;
    throw new Error("sync-boom");
  });

  await assert.rejects(cache.get("a"), /sync-boom/);
  await flush();
  assert.strictEqual(cache.has("a"), false);

  await assert.rejects(cache.get("a"), /sync-boom/);
  assert.strictEqual(calls, 2);
});

test("capacity must be a positive integer", () => {
  const loader = new ControllableLoader();
  assert.throws(() => new PromiseCache(0, loader.loader), RangeError);
  assert.throws(() => new PromiseCache(1.5, loader.loader), RangeError);
  assert.throws(() => new PromiseCache(-1, loader.loader), RangeError);
});
