import { test } from "node:test";
import assert from "node:assert/strict";
import { source, computed, effect, metrics } from "../src/reactive.js";
test("读取事务期间不登记依赖，结束时一次登记", () => {
    metrics.reset();
    const a = source(1);
    const b = source(2);
    const observedDuringCompute = [];
    const c = computed(() => {
        // 事务进行中：此时尚不应有任何新订阅产生
        observedDuringCompute.push([a.subscriberCount(), b.subscriberCount()]);
        return a.get() + b.get();
    });
    assert.equal(a.subscriberCount(), 0);
    assert.equal(b.subscriberCount(), 0);
    assert.equal(c.get(), 3);
    assert.deepEqual(observedDuringCompute, [[0, 0]]);
    // 事务结束后一次性登记
    assert.equal(a.subscriberCount(), 1);
    assert.equal(b.subscriberCount(), 1);
    assert.equal(metrics.subscribes, 2);
    assert.equal(metrics.unsubscribes, 0);
});
test("同一依赖在一次事务中读取多次只登记一次", () => {
    metrics.reset();
    const a = source(1);
    const c = computed(() => a.get() + a.get() + a.get());
    assert.equal(c.get(), 3);
    assert.equal(a.subscriberCount(), 1);
    assert.equal(metrics.subscribes, 1);
});
test("依赖集合不变的重算不产生任何订阅/退订操作", () => {
    const a = source(1);
    let runs = 0;
    const c = computed(() => {
        runs++;
        return a.get() * 2;
    });
    assert.equal(c.get(), 2);
    metrics.reset();
    a.set(2);
    assert.equal(c.get(), 4);
    assert.equal(runs, 2);
    assert.equal(metrics.subscribes, 0);
    assert.equal(metrics.unsubscribes, 0);
});
test("菱形依赖：每个节点恰好重算一次，无毛刺", () => {
    const s = source(1);
    let m1Runs = 0;
    let m2Runs = 0;
    let sumRuns = 0;
    const m1 = computed(() => {
        m1Runs++;
        return s.get() + 1;
    });
    const m2 = computed(() => {
        m2Runs++;
        return s.get() + 2;
    });
    const sum = computed(() => {
        sumRuns++;
        return m1.get() + m2.get();
    });
    const seen = [];
    effect(() => {
        seen.push(sum.get());
    });
    assert.deepEqual(seen, [5]);
    s.set(2);
    assert.deepEqual(seen, [5, 7]);
    assert.equal(m1Runs, 2);
    assert.equal(m2Runs, 2);
    assert.equal(sumRuns, 2);
});
