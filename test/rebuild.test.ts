import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BuildCache } from "../src/cache.js";
import { MemoryFileStore } from "../src/store.js";

describe("dependencies may change across rebuilds", () => {
  test("discovered deps replace the old edge set", async () => {
    const store = new MemoryFileStore();
    store.write("config", "x");
    store.write("x", "X-content");
    store.write("y", "Y-content");

    const cache = new BuildCache(store);
    cache.define("bundle", (ctx) => {
      const listed = ctx.readFile("config").split(",").filter(Boolean);
      return listed.map((f) => ctx.readFile(f)).join("|");
    });

    assert.equal(await cache.build("bundle"), "X-content");
    assert.deepEqual([...cache.graph.dependencies("bundle")].sort(), ["config", "x"]);

    // Rebuild with a different dependency set: config now lists y.
    store.write("config", "y");
    cache.invalidate(["config"]);
    assert.equal(await cache.build("bundle"), "Y-content");
    assert.deepEqual([...cache.graph.dependencies("bundle")].sort(), ["config", "y"]);

    // The stale dep "x" must no longer invalidate the bundle.
    store.write("x", "X-changed");
    const result = cache.invalidate(["x"]);
    assert.deepEqual(result.evicted, []);
    assert.equal(await cache.build("bundle"), "Y-content", "still cached");

    // The new dep "y" does invalidate it.
    store.write("y", "Y-changed");
    cache.invalidate(["y"]);
    assert.equal(await cache.build("bundle"), "Y-changed");
  });
});

describe("version check before publish", () => {
  test("a result computed from inputs that changed mid-build is not published", async () => {
    const store = new MemoryFileStore();
    store.write("f", "before");
    const cache = new BuildCache(store);
    let runs = 0;

    cache.define("slow", async (ctx) => {
      runs++;
      const observed = ctx.readFile("f");
      // A concurrent writer modifies the input while this task is in flight.
      if (runs === 1) store.write("f", "after");
      return observed;
    });

    const value = await cache.build("slow");
    assert.equal(runs, 2, "task must be re-run after detecting the mid-build change");
    assert.equal(value, "after", "the published value reflects the stable input");
    const entry = cache.getEntry("slow");
    assert.ok(entry);
    assert.equal(entry.value, "after");
    assert.equal(entry.deps.get("f"), store.version("f"), "published dep version matches the store");
    assert.equal(cache.lastRetries().length, 1);
    assert.equal(cache.lastRetries()[0]?.key, "slow");
  });

  test("gives up after maxRetries when inputs never stabilize", async () => {
    const store = new MemoryFileStore();
    store.write("f", "0");
    const cache = new BuildCache(store, { maxRetries: 3 });
    let counter = 0;
    cache.define("flaky", (ctx) => {
      const observed = ctx.readFile("f");
      counter++;
      store.write("f", String(counter)); // changes on every single run
      return observed;
    });
    await assert.rejects(cache.build("flaky"), /never observed stable inputs/);
    assert.equal(cache.getEntry("flaky"), undefined, "nothing stale was published");
  });

  test("stale cache entries are detected via input versions even without invalidate()", async () => {
    const store = new MemoryFileStore();
    store.write("f", "v1-content");
    const cache = new BuildCache(store);
    cache.define("a", (ctx) => ctx.readFile("f").toUpperCase());

    assert.equal(await cache.build("a"), "V1-CONTENT");
    store.write("f", "v2-content"); // no invalidate() call
    assert.equal(await cache.build("a"), "V2-CONTENT", "version mismatch forces a rebuild");
  });
});
