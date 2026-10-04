import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BuildCache } from "../src/cache.js";
import { MemoryFileStore } from "../src/store.js";

function setup() {
  const store = new MemoryFileStore();
  store.write("f1", "one");
  store.write("f2", "two");
  store.write("f4", "four");
  const cache = new BuildCache(store);
  const runs = new Map<string, number>();
  const counted = <T>(key: string, fn: () => T): (() => T) => {
    return () => {
      runs.set(key, (runs.get(key) ?? 0) + 1);
      return fn();
    };
  };
  cache.define("a1", (ctx) => counted("a1", () => `a1:${ctx.readFile("f1")}`)());
  cache.define("a2", (ctx) => counted("a2", () => `a2:${ctx.readFile("f1")}+${ctx.readFile("f2")}`)());
  cache.define("a3", async (ctx) => counted("a3", () => "a3:")() + (await ctx.read<string>("a1")));
  cache.define("a4", (ctx) => counted("a4", () => `a4:${ctx.readFile("f4")}`)());
  return { store, cache, runs };
}

describe("batch invalidation", () => {
  test("only the reverse-reachable closure is evicted", async () => {
    const { store, cache, runs } = setup();
    await cache.build("a1");
    await cache.build("a2");
    await cache.build("a3");
    await cache.build("a4");
    assert.equal(runs.get("a1"), 1);

    store.write("f1", "ONE");
    store.write("f2", "TWO");
    const result = cache.invalidate(["f1", "f2"]);

    assert.deepEqual([...result.closure].sort(), ["a1", "a2", "a3", "f1", "f2"]);
    assert.deepEqual([...result.evicted].sort(), ["a1", "a2", "a3"]);
    assert.ok(cache.getEntry("a4"), "unrelated entry must survive");
    assert.ok(!cache.getEntry("a1"));

    await cache.build("a3");
    assert.equal(runs.get("a1"), 2, "a1 rebuilt");
    assert.equal(runs.get("a3"), 2, "a3 rebuilt");
    assert.equal(runs.get("a4"), 1, "a4 never rebuilt");
    assert.equal(cache.getEntry("a3")?.value, "a3:a1:ONE");
  });

  test("unchanged inputs keep results cached across builds", async () => {
    const { cache, runs } = setup();
    await cache.build("a3");
    await cache.build("a3");
    await cache.build("a2");
    assert.equal(runs.get("a1"), 1);
    assert.equal(runs.get("a3"), 1);
  });
});
