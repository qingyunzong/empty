import { test } from "node:test";
import assert from "node:assert/strict";
import { source, computed, effect, metrics } from "../src/reactive.js";
import * as ref from "../src/refcount.js";

test("计算抛错不改变旧依赖，恢复后照常重算", () => {
  const a = source(1);
  const b = source(10);
  const fail = source(false);
  const c = computed(() => {
    if (fail.get()) throw new Error("boom");
    return a.get() + b.get();
  });
  assert.equal(c.get(), 11);
  assert.equal(c.dependencyCount(), 3);
  metrics.reset();

  fail.set(true);
  assert.throws(() => c.get(), /boom/);
  // 旧依赖全部保留：没有任何退订发生
  assert.equal(a.subscriberCount(), 1);
  assert.equal(b.subscriberCount(), 1);
  assert.equal(fail.subscriberCount(), 1);
  assert.equal(c.dependencyCount(), 3);
  assert.equal(metrics.unsubscribes, 0);
  assert.equal(metrics.subscribes, 0);
  // 缓存的错误持续重抛
  assert.throws(() => c.get(), /boom/);

  // 恢复：旧依赖仍在，源变化能触发重算
  fail.set(false);
  a.set(2);
  assert.equal(c.get(), 12);
});

test("effect 抛错同样保留旧依赖", () => {
  const a = source(1);
  const fail = source(false);
  const e = effect(() => {
    if (fail.get()) throw new Error("effect boom");
    a.get();
  });
  assert.equal(e.dependencyCount(), 2);
  fail.set(true);
  assert.ok(e.error instanceof Error);
  assert.equal(e.dependencyCount(), 2);
  assert.equal(a.subscriberCount(), 1);
  assert.equal(fail.subscriberCount(), 1);
  e.dispose();
});

test("对照：引用计数实现抛错后丢失旧依赖", () => {
  const a = ref.source(1);
  const fail = ref.source(false);
  const c = ref.computed(() => {
    if (fail.get()) throw new Error("boom");
    return a.get();
  });
  assert.equal(c.get(), 1);
  assert.equal(a.subscriberCount(), 1);
  fail.set(true);
  assert.throws(() => c.get(), /boom/);
  // 重算开始时已退订全部旧依赖，抛错后不会恢复
  assert.equal(a.subscriberCount(), 0);
});
