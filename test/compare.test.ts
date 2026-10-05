import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, computed, effect } from "../src/reactive.js";
import { FullRecomputeRoot, RefSignal, RefComputed } from "../src/variants.js";

test("对照·全量重算：无关写入也重跑全部 effect，事务式只重算受影响节点", () => {
  // 全量重算
  const root = new FullRecomputeRoot();
  const fa = root.signal(1);
  const fb = root.signal(10);
  const e1 = root.effect(() => void fa.get());
  const e2 = root.effect(() => void fb.get());
  fa.set(2);
  assert.equal(e1.runs, 2);
  assert.equal(e2.runs, 2, "全量重算：与 a 无关的 e2 也被重跑");

  // 事务式
  const a = signal(1);
  const b = signal(10);
  const c1 = computed(() => a.get() * 2);
  const c2 = computed(() => b.get() * 2);
  const t1 = effect(() => void c1.get());
  const t2 = effect(() => void c2.get());
  a.set(2);
  assert.equal(t1.runCount, 2);
  assert.equal(t2.runCount, 1, "事务式：与 a 无关的 effect 不重跑");
  assert.equal(c2.evaluationCount, 1, "未受影响的 computed 不重算");
});

test("对照·引用计数：抛错留下半成品依赖，事务式保持旧依赖", () => {
  // 引用计数：边读边订阅，抛错时旧依赖已释放、新依赖只订阅了一半
  const ra = new RefSignal(1);
  const rb = new RefSignal(10);
  const rc = new RefSignal(100);
  let boom = false;
  const rd = new RefComputed(() => {
    const x = ra.get();
    if (boom) {
      rc.get();
      throw new Error("boom");
    }
    return x + rb.get();
  });

  assert.equal(rd.get(), 11);
  assert.equal(ra.subscriberCount, 1);
  assert.equal(rb.subscriberCount, 1);

  boom = true;
  ra.set(2);
  assert.throws(() => rd.get(), /boom/);
  // 对照点：引用计数下依赖被“半成品”覆盖 —— b 的订阅丢失、c 多出租借
  assert.equal(rb.subscriberCount, 0, "引用计数：抛错导致旧依赖丢失");
  assert.equal(rc.subscriberCount, 1, "引用计数：抛错前读到的 c 残留订阅");

  // 事务式：同样的场景旧依赖不变（详见 reactive.test.ts）
  const a = signal(1);
  const b = signal(10);
  const c = signal(100);
  let txBoom = false;
  const d = computed(() => {
    const x = a.get();
    if (txBoom) {
      c.get();
      throw new Error("boom");
    }
    return x + b.get();
  });
  assert.equal(d.get(), 11);
  txBoom = true;
  a.set(2);
  assert.throws(() => d.get(), /boom/);
  assert.equal(b.subscriberCount, 1, "事务式：旧依赖保留");
  assert.equal(c.subscriberCount, 0, "事务式：抛错事务不登记新依赖");
});

test("对照·引用计数：归零级联释放上游；事务式由 dispose 精确退订", () => {
  // 引用计数链：leaf 释放后沿链归零
  const rs = new RefSignal(1);
  const rm = new RefComputed(() => rs.get() * 2);
  const rl = new RefComputed(() => rm.get() + 1);
  assert.equal(rl.get(), 3);
  assert.equal(rs.refCount, 1);
  assert.equal(rm.refCount, 1);
  rm._release(rl as never); // 模拟唯一消费者释放
  assert.equal(rm.refCount, 0);
  assert.equal(rs.refCount, 0, "引用计数归零后级联释放上游");

  // 事务式：dispose 沿链精确退订
  const s = signal(1);
  const m = computed(() => s.get() * 2);
  const l = computed(() => m.get() + 1);
  const e = effect(() => void l.get());
  assert.equal(s.subscriberCount, 1);
  assert.equal(m.subscriberCount, 1);
  e.dispose();
  assert.equal(l.subscriberCount, 0, "effect 退订 l");
  assert.equal(m.subscriberCount, 1, "l 仍持有 m 的订阅");
  l.dispose();
  assert.equal(m.subscriberCount, 0);
  m.dispose();
  assert.equal(s.subscriberCount, 0, "dispose 后源上无残留");
});
