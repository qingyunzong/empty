import assert from "node:assert/strict";
import test from "node:test";
import { TenantGenerationCache } from "../src/cache.js";
import { deferred } from "../src/deferred.js";

test("same key name is isolated across tenants", async () => {
  const cache = new TenantGenerationCache<string>();
  const loadA = deferred<string>();
  const loadB = deferred<string>();
  let callsA = 0;
  let callsB = 0;

  const pA = cache.getOrLoad("tenant-a", "doc:1", () => (callsA++, loadA.promise));
  const pB = cache.getOrLoad("tenant-b", "doc:1", () => (callsB++, loadB.promise));

  loadA.resolve("value-for-A");
  loadB.resolve("value-for-B");

  assert.equal(await pA, "value-for-A");
  assert.equal(await pB, "value-for-B");
  assert.equal(cache.get("tenant-a", "doc:1"), "value-for-A");
  assert.equal(cache.get("tenant-b", "doc:1"), "value-for-B");
  assert.equal(callsA, 1);
  assert.equal(callsB, 1);

  // Revoking one tenant must not disturb the other tenant's namespace.
  cache.revokePermissions("tenant-a");
  assert.equal(cache.get("tenant-a", "doc:1"), undefined);
  assert.equal(cache.get("tenant-b", "doc:1"), "value-for-B");
});

test("permission change atomically switches namespace", async () => {
  const cache = new TenantGenerationCache<string>();
  cache.setPermissions("tenant-a", ["read"]);
  assert.equal(cache.generationOf("tenant-a"), 1);

  const load = deferred<string>();
  const p = cache.getOrLoad("tenant-a", "doc:1", () => load.promise);
  load.resolve("v1");
  await p;
  assert.equal(cache.get("tenant-a", "doc:1"), "v1");
  assert.equal(cache.size("tenant-a"), 1);

  // The switch is synchronous: right after the call, the old namespace is gone.
  const gen = cache.setPermissions("tenant-a", ["read", "write"]);
  assert.equal(gen, 2);
  assert.deepEqual([...cache.permissionsOf("tenant-a")!], ["read", "write"]);
  assert.equal(cache.get("tenant-a", "doc:1"), undefined);
  assert.equal(cache.size("tenant-a"), 0);
});

test("stale in-flight result is not published into the new namespace", async () => {
  const cache = new TenantGenerationCache<string>();
  const staleLoad = deferred<string>();

  const p = cache.getOrLoad("tenant-a", "doc:1", () => staleLoad.promise);
  assert.equal(cache.generationOf("tenant-a"), 0);

  cache.revokePermissions("tenant-a");
  assert.equal(cache.generationOf("tenant-a"), 1);

  staleLoad.resolve("stale-value");
  assert.equal(await p, "stale-value");

  // The waiter got the original generation's result, but nothing was
  // published into the generation-1 namespace.
  assert.equal(cache.get("tenant-a", "doc:1"), undefined);
  assert.equal(cache.size("tenant-a"), 0);
});

test("waiters only observe the result of the generation they attached to", async () => {
  const cache = new TenantGenerationCache<string>();
  const staleLoad = deferred<string>();
  const freshLoad = deferred<string>();
  let loaderCalls = 0;

  const loader = () => {
    loaderCalls += 1;
    return loaderCalls === 1 ? staleLoad.promise : freshLoad.promise;
  };

  const waiter1 = cache.getOrLoad("tenant-a", "doc:1", loader);
  const waiter2 = cache.getOrLoad("tenant-a", "doc:1", loader);
  assert.equal(loaderCalls, 1, "concurrent waiters share one in-flight load");

  cache.revokePermissions("tenant-a");

  // A caller arriving after the switch starts a new load in generation 1.
  const waiter3 = cache.getOrLoad("tenant-a", "doc:1", loader);
  assert.equal(loaderCalls, 2);

  staleLoad.resolve("original-generation-result");
  freshLoad.resolve("new-generation-result");

  assert.equal(await waiter1, "original-generation-result");
  assert.equal(await waiter2, "original-generation-result");
  assert.equal(await waiter3, "new-generation-result");

  // Only the generation-1 result is cached.
  assert.equal(cache.get("tenant-a", "doc:1"), "new-generation-result");
  assert.equal(cache.size("tenant-a"), 1);
});

test("permission revocation drops cached entries and requires reload", async () => {
  const cache = new TenantGenerationCache<string>();
  const first = deferred<string>();
  const second = deferred<string>();
  let loaderCalls = 0;

  const loader = () => {
    loaderCalls += 1;
    return loaderCalls === 1 ? first.promise : second.promise;
  };

  const p1 = cache.getOrLoad("tenant-a", "doc:1", loader);
  first.resolve("before-revoke");
  await p1;
  assert.equal(cache.get("tenant-a", "doc:1"), "before-revoke");

  cache.revokePermissions("tenant-a");
  assert.equal(cache.get("tenant-a", "doc:1"), undefined);
  assert.equal(cache.permissionsOf("tenant-a"), undefined);

  const p2 = cache.getOrLoad("tenant-a", "doc:1", loader);
  assert.equal(loaderCalls, 2, "revoked namespace forces a fresh load");
  second.resolve("after-revoke");
  assert.equal(await p2, "after-revoke");
  assert.equal(cache.get("tenant-a", "doc:1"), "after-revoke");
});

test("lru eviction within a namespace and explicit evict", async () => {
  const cache = new TenantGenerationCache<string>({ maxEntriesPerNamespace: 2 });
  const put = (key: string, value: string) =>
    cache.getOrLoad("tenant-a", key, () => Promise.resolve(value));

  await put("k1", "v1");
  await put("k2", "v2");
  assert.equal(cache.size("tenant-a"), 2);

  // Touch k1 so k2 becomes the least recently used.
  assert.equal(cache.get("tenant-a", "k1"), "v1");

  await put("k3", "v3");
  assert.equal(cache.size("tenant-a"), 2);
  assert.equal(cache.get("tenant-a", "k1"), "v1", "recently used entry survives");
  assert.equal(cache.get("tenant-a", "k2"), undefined, "lru entry is evicted");
  assert.equal(cache.get("tenant-a", "k3"), "v3");

  assert.equal(cache.evict("tenant-a", "k1"), true);
  assert.equal(cache.get("tenant-a", "k1"), undefined);
  assert.equal(cache.evict("tenant-a", "missing"), false);

  // Eviction is scoped to the current generation only.
  cache.revokePermissions("tenant-a");
  assert.equal(cache.size("tenant-a"), 0);
  assert.equal(cache.get("tenant-a", "k3"), undefined);
});

test("rejected load clears in-flight state so a retry can proceed", async () => {
  const cache = new TenantGenerationCache<string>();
  const failing = deferred<string>();

  const p1 = cache.getOrLoad("tenant-a", "doc:1", () => failing.promise);
  failing.reject(new Error("backend down"));
  await assert.rejects(p1, /backend down/);

  const p2 = cache.getOrLoad("tenant-a", "doc:1", () => Promise.resolve("recovered"));
  assert.equal(await p2, "recovered");
  assert.equal(cache.get("tenant-a", "doc:1"), "recovered");
});
