import { test } from "node:test";
import assert from "node:assert/strict";
import * as main from "../src/reactive.js";
import * as ref from "../src/refcount.js";
import * as full from "../src/full-recompute.js";

interface Impl {
  source<T>(v: T): { get(): T; set(v: T): void };
  computed<T>(fn: () => T): { get(): T };
  effect(fn: () => void): { dispose(): void };
}

interface Counts {
  c: number;
  d: number;
  effect: number;
}

/** 同一场景在三种实现上运行：菱形 + 条件切换 + 无关噪声源。 */
function scenario(impl: Impl): Counts {
  const counts: Counts = { c: 0, d: 0, effect: 0 };
  const cond = impl.source(true);
  const a = impl.source(1);
  const b = impl.source(10);
  const noise = impl.source(0);
  const c = impl.computed(() => {
    counts.c++;
    return cond.get() ? a.get() : b.get();
  });
  const d = impl.computed(() => {
    counts.d++;
    return c.get() * 2;
  });
  const e = impl.effect(() => {
    counts.effect++;
    d.get();
  });
  a.set(2);
  a.set(3);
  a.set(4);
  cond.set(false); // 条件切换：a 不再是依赖
  b.set(20);
  a.set(5); // 切换后修改 a：主库与引用计数不应重算
  noise.set(1); // 无关源：只有全量重算会被惊动
  noise.set(2);
  e.dispose();
  return counts;
}

const mainImpl: Impl = {
  source: main.source,
  computed: main.computed,
  effect: main.effect,
};
const refImpl: Impl = {
  source: ref.source,
  computed: ref.computed,
  effect: ref.effect,
};
const fullImpl: Impl = {
  source: full.source,
  computed: full.computed,
  effect: full.effect,
};

test("对照：主库 vs 全量重算 vs 引用计数", () => {
  main.metrics.reset();
  const mainCounts = scenario(mainImpl);
  const mainSubs = main.metrics.subscribes;
  const mainUnsubs = main.metrics.unsubscribes;

  ref.metrics.reset();
  const refCounts = scenario(refImpl);
  const refSubs = ref.metrics.subscribes;
  const refUnsubs = ref.metrics.unsubscribes;

  const fullCounts = scenario(fullImpl);

  console.log("\n=== 同一场景在三种实现上的对照 ===");
  console.log("场景：cond?a:b → *2 → effect；a 改 3 次、切换 cond、b 改 1 次、");
  console.log("      切换后再改 a 1 次、无关源 noise 改 2 次。");
  console.log("");
  console.log("| 实现             | c 重算 | d 重算 | effect 运行 | 订阅操作 | 退订操作 |");
  console.log("| ---------------- | ------ | ------ | ----------- | -------- | -------- |");
  console.log(
    `| 主库（事务提交） | ${mainCounts.c}      | ${mainCounts.d}      | ${mainCounts.effect}           | ${mainSubs}        | ${mainUnsubs}        |`,
  );
  console.log(
    `| 引用计数         | ${refCounts.c}      | ${refCounts.d}      | ${refCounts.effect}           | ${refSubs}       | ${refUnsubs}       |`,
  );
  console.log(
    `| 全量重算         | ${fullCounts.c}     | ${fullCounts.d}     | ${fullCounts.effect}          | （无跟踪） | （无跟踪） |`,
  );
  console.log("");

  // 主库：按需重算 —— 初始 1 次 + a×3 + 切换 1 次 + b×1 次 = 6；
  // 切换后改 a、改 noise 均不触发。
  assert.deepEqual(mainCounts, { c: 6, d: 6, effect: 6 });
  // 引用计数：重算次数相同（同样是惰性求值），但订阅 churn 明显更多。
  assert.deepEqual(refCounts, { c: 6, d: 6, effect: 6 });
  assert.ok(refSubs > mainSubs * 3, `引用计数订阅操作(${refSubs})应远多于主库(${mainSubs})`);
  assert.ok(refUnsubs > mainUnsubs * 3, `引用计数退订操作(${refUnsubs})应远多于主库(${mainUnsubs})`);
  // 全量重算：任何源变化都重跑整个链路。
  assert.ok(fullCounts.effect > mainCounts.effect, "全量重算的 effect 运行次数更多");
  assert.equal(fullCounts.effect, 9); // 初始 + a×3 + cond + b + a + noise×2
  assert.equal(fullCounts.c, 9);
  assert.equal(fullCounts.d, 9);
});
