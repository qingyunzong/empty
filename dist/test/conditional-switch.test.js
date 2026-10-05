import { test } from "node:test";
import assert from "node:assert/strict";
import { source, computed, effect, batch } from "../src/reactive.js";
test("条件切换清理不再读取的依赖", () => {
    const cond = source(true);
    const a = source(1);
    const b = source(100);
    let runs = 0;
    const c = computed(() => {
        runs++;
        return cond.get() ? a.get() : b.get();
    });
    assert.equal(c.get(), 1);
    assert.equal(a.subscriberCount(), 1);
    assert.equal(b.subscriberCount(), 0);
    cond.set(false);
    assert.equal(c.get(), 100);
    assert.equal(a.subscriberCount(), 0); // 不再读取的依赖被清理
    assert.equal(b.subscriberCount(), 1);
    const runsAfterSwitch = runs;
    a.set(999); // a 已不再是依赖：不触发重算
    assert.equal(runs, runsAfterSwitch);
    assert.equal(c.get(), 100);
    b.set(200); // b 仍是依赖：触发重算
    assert.equal(c.get(), 200);
    assert.equal(runs, runsAfterSwitch + 1);
    cond.set(true); // 切回：b 被清理，a 重新订阅
    assert.equal(c.get(), 999);
    assert.equal(a.subscriberCount(), 1);
    assert.equal(b.subscriberCount(), 0);
});
test("effect 中的动态切换与 batch", () => {
    const cond = source(true);
    const a = source(1);
    const b = source(2);
    const seen = [];
    effect(() => {
        seen.push(cond.get() ? a.get() : b.get());
    });
    assert.deepEqual(seen, [1]);
    batch(() => {
        cond.set(false);
        b.set(20);
    });
    assert.deepEqual(seen, [1, 20]); // batch 内多次 set 只运行一次
    assert.equal(a.subscriberCount(), 0);
    assert.equal(b.subscriberCount(), 1);
    a.set(100);
    assert.deepEqual(seen, [1, 20]); // a 已退订，不再触发
});
test("嵌套 computed 的条件切换沿链清理", () => {
    const cond = source(true);
    const a = source(1);
    const b = source(2);
    const inner = computed(() => (cond.get() ? a.get() : b.get()));
    const outer = computed(() => inner.get() * 10);
    const seen = [];
    effect(() => {
        seen.push(outer.get());
    });
    assert.deepEqual(seen, [10]);
    cond.set(false);
    assert.deepEqual(seen, [10, 20]);
    assert.equal(a.subscriberCount(), 0);
    assert.equal(b.subscriberCount(), 1);
    a.set(5);
    assert.deepEqual(seen, [10, 20]);
});
