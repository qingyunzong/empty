import test from "node:test";
import assert from "node:assert/strict";
import { GenerationCache } from "../src/cache.js";
import { deferred } from "../src/deferred.js";

function valueLoader<V>(value: V, calls?: { n: number }): () => Promise<V> {
  return async () => {
    if (calls) calls.n += 1;
    return value;
  };
}

test("同名资源跨租户隔离：键含租户，互不可见", async () => {
  const cache = new GenerationCache();
  const callsA = { n: 0 };
  const callsB = { n: 0 };

  const a1 = await cache.get("tenant-a", "doc", "k1", valueLoader("A1", callsA));
  const b1 = await cache.get("tenant-b", "doc", "k1", valueLoader("B1", callsB));
  const a2 = await cache.get("tenant-a", "doc", "k1", valueLoader("A2", callsA));

  assert.equal(a1, "A1");
  assert.equal(b1, "B1");
  assert.equal(a2, "A1");
  assert.equal(callsA.n, 1);
  assert.equal(callsB.n, 1);
});

test("并发获取去重：同一在途加载只执行一次", async () => {
  const cache = new GenerationCache();
  const calls = { n: 0 };
  const gate = deferred<string>();

  const p1 = cache.get("t", "doc", "k", async () => {
    calls.n += 1;
    return gate.promise;
  });
  const p2 = cache.get("t", "doc", "k", valueLoader("other", calls));

  gate.resolve("v");
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1, "v");
  assert.equal(r2, "v");
  assert.equal(calls.n, 1);
});

test("权限撤销原子切换命名空间：旧缓存对新代不可见", async () => {
  const cache = new GenerationCache();
  const calls = { n: 0 };

  const before = await cache.get("t", "doc", "k", valueLoader("gen0", calls));
  assert.equal(before, "gen0");
  assert.equal(cache.generation("t", "doc"), 0);

  const newGen = cache.revoke("t", "doc");
  assert.equal(newGen, 1);
  assert.equal(cache.generation("t", "doc"), 1);

  const after = await cache.get("t", "doc", "k", valueLoader("gen1", calls));
  assert.equal(after, "gen1");
  assert.equal(calls.n, 2);
});

test("旧在途结果不得发布到新命名空间", async () => {
  const cache = new GenerationCache();
  const stale = deferred<string>();
  const newCalls = { n: 0 };

  const inflight = cache.get("t", "doc", "k", () => stale.promise);
  cache.revoke("t", "doc");
  stale.resolve("stale-value");

  const waiterResult = await inflight;
  assert.equal(waiterResult, "stale-value");

  const fresh = await cache.get("t", "doc", "k", valueLoader("fresh-value", newCalls));
  assert.equal(fresh, "fresh-value");
  assert.equal(newCalls.n, 1);

  const again = await cache.get("t", "doc", "k", valueLoader("unexpected", newCalls));
  assert.equal(again, "fresh-value");
  assert.equal(newCalls.n, 1);
});

test("等待者只取原代结果，撤销后新读者取新代结果", async () => {
  const cache = new GenerationCache();
  const stale = deferred<string>();

  const waiter1 = cache.get("t", "doc", "k", () => stale.promise);
  const waiter2 = cache.get("t", "doc", "k", valueLoader("never"));

  cache.revoke("t", "doc");
  const freshReader = cache.get("t", "doc", "k", valueLoader("gen1-value"));

  stale.resolve("gen0-value");

  assert.equal(await waiter1, "gen0-value");
  assert.equal(await waiter2, "gen0-value");
  assert.equal(await freshReader, "gen1-value");
});

test("撤销不影响其他租户的命名空间", async () => {
  const cache = new GenerationCache();
  const callsB = { n: 0 };

  await cache.get("tenant-a", "doc", "k", valueLoader("a"));
  await cache.get("tenant-b", "doc", "k", valueLoader("b", callsB));

  cache.revoke("tenant-a", "doc");

  const b = await cache.get("tenant-b", "doc", "k", valueLoader("b2", callsB));
  assert.equal(b, "b");
  assert.equal(callsB.n, 1);
  assert.equal(cache.generation("tenant-a", "doc"), 1);
  assert.equal(cache.generation("tenant-b", "doc"), 0);
});

test("TTL 到期淘汰", async () => {
  let clock = 1000;
  const cache = new GenerationCache({ ttlMs: 100, now: () => clock });
  const calls = { n: 0 };

  const v1 = await cache.get("t", "doc", "k", valueLoader("v1", calls));
  clock += 50;
  const v2 = await cache.get("t", "doc", "k", valueLoader("v2", calls));
  clock += 100;
  const v3 = await cache.get("t", "doc", "k", valueLoader("v3", calls));

  assert.equal(v1, "v1");
  assert.equal(v2, "v1");
  assert.equal(v3, "v3");
  assert.equal(calls.n, 2);
});

test("LRU 容量淘汰：超出上限逐出最久未用条目", async () => {
  const cache = new GenerationCache({ maxEntriesPerNamespace: 2 });
  const calls = { n: 0 };

  await cache.get("t", "doc", "a", valueLoader("a1", calls));
  await cache.get("t", "doc", "b", valueLoader("b1", calls));
  await cache.get("t", "doc", "a", valueLoader("a2", calls));
  await cache.get("t", "doc", "c", valueLoader("c1", calls));

  const c = await cache.get("t", "doc", "c", valueLoader("c2", calls));
  const a = await cache.get("t", "doc", "a", valueLoader("a3", calls));
  const b = await cache.get("t", "doc", "b", valueLoader("b2", calls));

  assert.equal(c, "c1");
  assert.equal(a, "a1");
  assert.equal(b, "b2");
  assert.equal(calls.n, 4);
});

test("evict 显式淘汰当前代条目", async () => {
  const cache = new GenerationCache();
  const calls = { n: 0 };

  await cache.get("t", "doc", "k", valueLoader("v1", calls));
  assert.equal(cache.evict("t", "doc", "k"), true);
  assert.equal(cache.evict("t", "doc", "k"), false);

  const v = await cache.get("t", "doc", "k", valueLoader("v2", calls));
  assert.equal(v, "v2");
  assert.equal(calls.n, 2);
});

test("加载失败：错误传播给所有等待者且不写入缓存", async () => {
  const cache = new GenerationCache();
  const boom = new Error("boom");
  const calls = { n: 0 };

  const p1 = cache.get("t", "doc", "k", async () => {
    calls.n += 1;
    throw boom;
  });
  const p2 = cache.get("t", "doc", "k", valueLoader("never"));

  await assert.rejects(p1, /boom/);
  await assert.rejects(p2, /boom/);

  const v = await cache.get("t", "doc", "k", valueLoader("recovered", calls));
  assert.equal(v, "recovered");
  assert.equal(calls.n, 2);
});
