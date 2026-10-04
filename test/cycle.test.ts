import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BuildCache } from "../src/cache.js";
import { MemoryFileStore } from "../src/store.js";

function cyclicCache() {
  const store = new MemoryFileStore();
  store.write("cap", "5");
  const cache = new BuildCache(store);
  // a = min(b + 1, cap), b = min(a + 1, cap): mutually recursive, converges to cap.
  cache.define<number>("a", async (ctx) => Math.min((await ctx.read<number>("b")) + 1, Number(ctx.readFile("cap"))), {
    seed: () => 0,
  });
  cache.define<number>("b", async (ctx) => Math.min((await ctx.read<number>("a")) + 1, Number(ctx.readFile("cap"))), {
    seed: () => 0,
  });
  return { store, cache };
}

describe("cyclic dependencies", () => {
  test("cycles are allowed and computed to a fixpoint", async () => {
    const { cache } = cyclicCache();
    assert.equal(await cache.build("a"), 5);
    assert.equal(cache.getEntry("b")?.value, 5);
    // Group members are published under one shared version stamp.
    assert.equal(cache.getEntry("a")?.version, cache.getEntry("b")?.version);
  });

  test("cycle evidence is a concrete dependency path", async () => {
    const { cache } = cyclicCache();
    await cache.build("a");

    const records = cache.lastCycles();
    assert.equal(records.length, 1);
    const evidence = records[0]?.evidence as string[];
    assert.equal(evidence[0], evidence[evidence.length - 1], "closed path");
    assert.equal(evidence.length, 3, "a -> b -> a");
    for (let i = 0; i + 1 < evidence.length; i++) {
      assert.ok(
        cache.graph.dependencies(evidence[i] as string).has(evidence[i + 1] as string),
        `edge ${evidence[i]} -> ${evidence[i + 1]} exists in the graph`,
      );
    }

    const graphCycles = cache.graph.cycles();
    assert.equal(graphCycles.length, 1);
    assert.deepEqual(graphCycles[0]?.members, ["a", "b"]);
  });

  test("invalidating one member's input evicts the whole cycle", async () => {
    const { store, cache } = cyclicCache();
    await cache.build("a");
    store.write("cap", "3");
    const result = cache.invalidate(["cap"]);
    assert.ok(result.evicted.includes("a"));
    assert.ok(result.evicted.includes("b"));
    assert.equal(await cache.build("a"), 3, "recomputed against the new cap");
    assert.equal(cache.getEntry("b")?.value, 3);
  });

  test("stale cyclic groups rebuild as a unit even without invalidate()", async () => {
    const { store, cache } = cyclicCache();
    await cache.build("a");
    store.write("cap", "2");
    assert.equal(await cache.build("b"), 2);
    assert.equal(cache.getEntry("a")?.value, 2);
  });

  test("cold-start cycle without a seed fails with a clear error", async () => {
    const store = new MemoryFileStore();
    const cache = new BuildCache(store);
    cache.define("x", async (ctx) => (await ctx.read("y")) as number);
    cache.define("y", async (ctx) => (await ctx.read("x")) as number);
    await assert.rejects(cache.build("x"), /no cached value and no seed/);
  });

  test("non-converging cycles fail with the cycle in the message", async () => {
    const store = new MemoryFileStore();
    const cache = new BuildCache(store, { maxCycleIterations: 8 });
    cache.define<number>("p", async (ctx) => (await ctx.read<number>("q")) + 1, { seed: () => 0 });
    cache.define<number>("q", async (ctx) => (await ctx.read<number>("p")) + 1, { seed: () => 0 });
    await assert.rejects(cache.build("p"), /did not converge/);
  });
});
