import { test } from "node:test";
import assert from "node:assert/strict";
import { source, computed, effect } from "../src/reactive.js";
import * as ref from "../src/refcount.js";
test("计算函数内自我销毁：提交被放弃，不留任何订阅", () => {
    const a = source(1);
    const b = source(2);
    let c;
    c = computed(() => {
        const x = a.get();
        c.dispose(); // 重算中途销毁
        return x + b.get(); // 销毁后仍有读取
    });
    assert.equal(c.get(), 3);
    assert.equal(c.disposed, true);
    assert.equal(a.subscriberCount(), 0);
    assert.equal(b.subscriberCount(), 0);
    assert.equal(c.dependencyCount(), 0);
});
test("flush 期间销毁另一个待运行的 effect：不再运行、不留订阅", () => {
    const s = source(0);
    const runs = [];
    let e2;
    const e1 = effect(() => {
        runs.push("e1");
        if (s.get() > 0)
            e2.dispose();
    });
    e2 = effect(() => {
        runs.push("e2");
        s.get();
    });
    assert.deepEqual(runs, ["e1", "e2"]);
    s.set(1); // e1 先运行并销毁 e2；e2 虽在队列中但被跳过
    assert.deepEqual(runs, ["e1", "e2", "e1"]);
    assert.equal(s.subscriberCount(), 1); // 只剩 e1
    s.set(2);
    assert.deepEqual(runs, ["e1", "e2", "e1", "e1"]);
    e1.dispose();
    assert.equal(s.subscriberCount(), 0);
});
test("销毁后再读取：一次性求值且不产生订阅", () => {
    const a = source(1);
    const c = computed(() => a.get() * 10);
    assert.equal(c.get(), 10);
    c.dispose();
    assert.equal(a.subscriberCount(), 0);
    a.set(5);
    assert.equal(c.get(), 50); // 仍能求值
    assert.equal(a.subscriberCount(), 0); // 但不留订阅
});
test("销毁后源变化不再通知（无残留订阅）", () => {
    const s = source(0);
    let runs = 0;
    const e = effect(() => {
        runs++;
        s.get();
    });
    e.dispose();
    s.set(1);
    s.set(2);
    assert.equal(runs, 1);
    assert.equal(s.subscriberCount(), 0);
});
test("对照：引用计数实现在销毁与重算交错时留下订阅", () => {
    const a = ref.source(1);
    const b = ref.source(2);
    let c;
    c = ref.computed(() => {
        const x = a.get();
        c.dispose(); // 退订当前全部依赖
        return x + b.get(); // 但读取时立即 acquire —— 泄漏
    });
    c.get();
    assert.equal(c.disposed, true);
    assert.equal(b.subscriberCount(), 1); // 泄漏的订阅
});
