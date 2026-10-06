import { test } from "node:test";
import { deepEqual, equal, notEqual, ok, rejects, throws } from "node:assert/strict";
import { PromiseCache } from "../src/promise-cache.js";
import { deferred } from "../src/deferred.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const never = <T>() => deferred<T>().promise;

test("同键并发请求共享同一个进行中 Promise", async () => {
  const cache = new PromiseCache<string, number>(2);
  const d = deferred<number>();
  let calls = 0;
  const loader = () => {
    calls++;
    return d.promise;
  };

  const p1 = cache.get("a", loader);
  const p2 = cache.get("a", loader);

  equal(calls, 1, "loader 只被调用一次");
  equal(p1, p2, "返回同一个 Promise 引用");

  d.resolve(42);
  deepEqual(await Promise.all([p1, p2]), [42, 42]);
  equal(calls, 1);
});

test("容量超限按 LRU 淘汰最久未使用的条目", () => {
  const cache = new PromiseCache<string, number>(2);
  cache.get("a", () => never<number>());
  cache.get("b", () => never<number>());
  cache.get("a", () => never<number>()); // 触碰 a，b 成为最久未使用
  cache.get("c", () => never<number>()); // 触发淘汰

  equal(cache.size, 2);
  ok(cache.has("a"));
  ok(cache.has("c"));
  ok(!cache.has("b"), "b 应被淘汰");
});

test("淘汰不取消已有等待者", async () => {
  const cache = new PromiseCache<string, string>(1);
  const d1 = deferred<string>();
  const p1 = cache.get("a", () => d1.promise);

  cache.get("b", () => never<string>()); // 挤掉 a
  ok(!cache.has("a"));

  d1.resolve("late-but-alive");
  equal(await p1, "late-but-alive", "已持有 Promise 的等待者照常收到结果");
});

test("同键再请求创建新任务，且迟到结果不会重新插回已淘汰世代", async () => {
  const cache = new PromiseCache<string, string>(1);
  const d1 = deferred<string>();
  const p1 = cache.get("a", () => d1.promise); // 世代 1

  cache.get("b", () => never<string>()); // 淘汰世代 1
  ok(!cache.has("a"));

  const d2 = deferred<string>();
  let calls = 0;
  const loader2 = () => {
    calls++;
    return d2.promise;
  };
  const p2 = cache.get("a", loader2); // 世代 2：同键再请求创建新任务
  equal(calls, 1);
  notEqual(p1, p2);

  d1.resolve("stale-gen1"); // 世代 1 迟到完成
  equal(await p1, "stale-gen1", "老等待者仍拿到自己世代的结果");
  await flush();

  equal(cache.size, 1, "迟到结果没有额外插回缓存");
  equal(cache.get("a", loader2), p2, "缓存中仍是世代 2");
  equal(calls, 1, "没有因迟到结果创建第三个任务");

  d2.resolve("fresh-gen2");
  equal(await cache.get("a", loader2), "fresh-gen2", "读到的是新世代的结果");
});

test("已淘汰世代的迟到失败不会误删新世代条目", async () => {
  const cache = new PromiseCache<string, string>(1);
  const d1 = deferred<string>();
  const p1 = cache.get("a", () => d1.promise);
  const handled1 = p1.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );

  cache.get("b", () => never<string>()); // 淘汰世代 1

  const d2 = deferred<string>();
  const p2 = cache.get("a", () => d2.promise); // 世代 2

  d1.reject(new Error("stale failure")); // 世代 1 迟到失败
  const settled1 = await handled1;
  ok(!settled1.ok, "世代 1 的等待者收到失败");
  await flush();

  ok(cache.has("a"), "世代 2 条目仍在缓存中");
  equal(cache.get("a", () => d2.promise), p2);

  d2.resolve("v2");
  equal(await p2, "v2");
});

test("失败删除条目，同键再请求创建新任务", async () => {
  const cache = new PromiseCache<string, string>(2);
  let calls = 0;

  const d1 = deferred<string>();
  const p1 = cache.get("a", () => {
    calls++;
    return d1.promise;
  });

  d1.reject(new Error("boom"));
  await rejects(p1, /boom/);

  ok(!cache.has("a"), "失败后条目被删除");
  equal(cache.size, 0);

  const d2 = deferred<string>();
  const p2 = cache.get("a", () => {
    calls++;
    return d2.promise;
  });
  equal(calls, 2, "重新请求创建了新任务");
  notEqual(p1, p2);

  d2.resolve("recovered");
  equal(await p2, "recovered");
});

test("成功结果留在缓存中，后续请求不再触发加载", async () => {
  const cache = new PromiseCache<string, number>(2);
  let calls = 0;
  const d = deferred<number>();
  const loader = () => {
    calls++;
    return d.promise;
  };

  const p1 = cache.get("a", loader);
  d.resolve(7);
  equal(await p1, 7);

  equal(await cache.get("a", loader), 7);
  equal(calls, 1, "已成功的结果被直接复用");
});

test("缓存大小永不超过容量", () => {
  const cache = new PromiseCache<number, number>(3);
  for (let i = 0; i < 10; i++) {
    cache.get(i, () => never<number>());
  }
  equal(cache.size, 3);
  ok(cache.has(7) && cache.has(8) && cache.has(9));
  ok(!cache.has(6));
});

test("非法容量直接抛错", () => {
  throws(() => new PromiseCache(0), /positive integer/);
  throws(() => new PromiseCache(-1), /positive integer/);
  throws(() => new PromiseCache(1.5), /positive integer/);
});
