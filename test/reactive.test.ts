import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, computed, effect } from "../src/reactive.js";

test("依赖在读取事务结束时一次登记：计算过程中源上没有任何订阅", () => {
  const a = signal(1);
  const b = signal(2);
  const observedDuringRun: Array<[number, number]> = [];

  const c = computed(() => {
    // 事务进行中：读取已发生，但订阅尚未登记
    observedDuringRun.push([a.subscriberCount, b.subscriberCount]);
    return a.get() + b.get();
  });

  assert.equal(c.get(), 3);
  assert.deepEqual(observedDuringRun, [[0, 0]], "计算期间不得有订阅登记");
  assert.equal(a.subscriberCount, 1, "事务结束后一次性登记");
  assert.equal(b.subscriberCount, 1);

  // 幂等：无变化时重复读取不重算、不重复登记
  assert.equal(c.get(), 3);
  assert.equal(c.evaluationCount, 1);
  assert.equal(a.subscriberCount, 1);
});

test("计算抛错不改变旧依赖：订阅集合与缓存值原样保留", () => {
  const a = signal(1);
  const b = signal(10);
  const c = signal(100);
  let boom = false;

  const d = computed(() => {
    const sum = a.get() + b.get();
    if (boom) {
      c.get(); // 抛错前读到了 c —— 事务式语义下这次读取不得生效
      throw new Error("boom");
    }
    return sum;
  });

  assert.equal(d.get(), 11);
  const depsBefore = d.deps.length;
  assert.equal(a.subscriberCount, 1);
  assert.equal(b.subscriberCount, 1);
  assert.equal(c.subscriberCount, 0);

  boom = true;
  a.set(2); // 使 d 变脏
  assert.throws(() => d.get(), /boom/);

  // 旧依赖不变：a、b 的订阅保留，c 未被登记
  assert.equal(d.deps.length, depsBefore);
  assert.equal(a.subscriberCount, 1);
  assert.equal(b.subscriberCount, 1);
  assert.equal(c.subscriberCount, 0, "抛错事务中的读取不得留下订阅");

  // 恢复后基于旧依赖正常重算
  boom = false;
  assert.equal(d.get(), 12);
  b.set(20);
  assert.equal(d.get(), 22);
});

test("销毁与重算交错：通知过程中 dispose 不留订阅、不再重算", () => {
  const s = signal(1);
  const c = computed(() => s.get() * 2);
  const seen: number[] = [];

  // s 的订阅者：e 与 c（e2 订阅的是 c）。通知顺序：e 先执行并销毁 c。
  const e = effect(() => {
    s.get();
    if (s.peek() === 2) c.dispose();
  });
  const e2 = effect(() => {
    seen.push(c.get());
  });

  assert.equal(s.subscriberCount, 2, "e 与 c 订阅了 s");
  seen.length = 0;

  s.set(2); // 通知快照中 c 在 e 之后，但 c 已被 dispose
  assert.equal(c.isDisposed, true);
  assert.equal(s.subscriberCount, 1, "c 的订阅必须被移除");

  s.set(3);
  const evals = c.evaluationCount;
  s.set(4);
  assert.equal(c.evaluationCount, evals, "销毁后不得再重算");
  assert.throws(() => c.get(), /已销毁/);
  e.dispose();
  e2.dispose();
  assert.equal(s.subscriberCount, 0, "全部销毁后源上无残留订阅");
});

test("销毁发生在自身计算事务中：提交阶段跳过，不留订阅", () => {
  const s = signal(1);
  let self!: ReturnType<typeof effect>;
  self = effect(() => {
    s.get();
    if (s.peek() > 1) self.dispose(); // 事务进行中销毁自己
  });
  s.set(2); // 触发重跑，重跑途中 dispose
  assert.equal(self.isDisposed, true);
  assert.equal(s.subscriberCount, 0, "销毁后的事务提交不得登记订阅");
});

test("动态条件切换：不再读取的依赖被清理", () => {
  const cond = signal(true);
  const a = signal(1);
  const b = signal(100);

  const c = computed(() => (cond.get() ? a.get() : b.get()));
  assert.equal(c.get(), 1);
  assert.equal(a.subscriberCount, 1);
  assert.equal(b.subscriberCount, 0, "未走到的分支不得订阅");

  cond.set(false); // 切换分支
  assert.equal(c.get(), 100);
  assert.equal(a.subscriberCount, 0, "不再读取的 a 必须退订");
  assert.equal(b.subscriberCount, 1);

  const evals = c.evaluationCount;
  a.set(999); // a 已退订，不得触发重算
  assert.equal(c.evaluationCount, evals);
  assert.equal(c.get(), 100);

  b.set(200); // b 仍在依赖中，触发重算
  assert.equal(c.get(), 200);
  assert.equal(c.evaluationCount, evals + 1);
});

test("嵌套派生：条件切换沿链清理，effect 只收到有效通知", () => {
  const cond = signal(true);
  const x = signal(1);
  const y = signal(10);
  const picked = computed(() => (cond.get() ? x.get() : y.get()));
  const doubled = computed(() => picked.get() * 2);
  const seen: number[] = [];
  const e = effect(() => {
    seen.push(doubled.get());
  });

  assert.deepEqual(seen, [2]);
  cond.set(false);
  assert.deepEqual(seen, [2, 20]);
  assert.equal(x.subscriberCount, 0);
  assert.equal(y.subscriberCount, 1);

  x.set(5); // 已退订，无通知
  assert.deepEqual(seen, [2, 20]);
  e.dispose();
  assert.equal(doubled.subscriberCount, 0, "effect 销毁后退订 doubled");
  doubled.dispose();
  assert.equal(picked.subscriberCount, 0, "doubled 销毁后退订 picked");
  picked.dispose();
  assert.equal(y.subscriberCount, 0, "沿链销毁后源上无残留");
});
