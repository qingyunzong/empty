"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const merge_1 = require("../src/merge");
class Deferred {
    promise;
    resolve;
    reject;
    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}
/**
 * A source whose every next() is a manually controlled promise.
 * Counts opens/closes and concurrent in-flight next() calls.
 */
class ControlledSource {
    openCount = 0;
    closeCount = 0;
    maxInFlight = 0;
    inFlight = 0;
    queue = [];
    [Symbol.asyncIterator]() {
        this.openCount += 1;
        const source = this;
        return {
            next() {
                source.inFlight += 1;
                source.maxInFlight = Math.max(source.maxInFlight, source.inFlight);
                const deferred = new Deferred();
                source.queue.push(deferred);
                deferred.promise.then(() => {
                    source.inFlight -= 1;
                }, () => {
                    source.inFlight -= 1;
                });
                return deferred.promise;
            },
            return() {
                source.closeCount += 1;
                // A well-behaved source settles its outstanding next() on close.
                for (const deferred of source.queue.splice(0)) {
                    deferred.resolve({ value: undefined, done: true });
                }
                return Promise.resolve({ value: undefined, done: true });
            },
        };
    }
    get pendingCount() {
        return this.queue.length;
    }
    shift() {
        const deferred = this.queue.shift();
        if (!deferred)
            throw new Error("no pending prefetch on this source");
        return deferred;
    }
    deliverNext(value) {
        this.shift().resolve({ value, done: false });
    }
    finishNext() {
        this.shift().resolve({ value: undefined, done: true });
    }
    failNext(error) {
        this.shift().reject(error);
    }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
(0, node_test_1.test)("结果按源轮转交付，与各项就绪顺序无关", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const c = new ControlledSource();
    const merged = (0, merge_1.mergeRoundRobin)([a, b, c]);
    // 创建后即每源各预取一项
    (0, strict_1.equal)(a.pendingCount, 1);
    (0, strict_1.equal)(b.pendingCount, 1);
    (0, strict_1.equal)(c.pendingCount, 1);
    // 乱序就绪，交付仍按源轮转
    c.deliverNext("c0");
    a.deliverNext("a0");
    b.deliverNext("b0");
    (0, strict_1.deepEqual)(await merged.next(), { value: "a0", done: false });
    (0, strict_1.deepEqual)(await merged.next(), { value: "b0", done: false });
    (0, strict_1.deepEqual)(await merged.next(), { value: "c0", done: false });
    // 第二轮（每次交付后该源已自动补一次预取）
    b.deliverNext("b1");
    a.deliverNext("a1");
    c.deliverNext("c1");
    (0, strict_1.deepEqual)(await merged.next(), { value: "a1", done: false });
    (0, strict_1.deepEqual)(await merged.next(), { value: "b1", done: false });
    (0, strict_1.deepEqual)(await merged.next(), { value: "c1", done: false });
    a.finishNext();
    b.finishNext();
    c.finishNext();
    (0, strict_1.deepEqual)(await merged.next(), { value: undefined, done: true });
});
(0, node_test_1.test)("每源最多一项预取", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const merged = (0, merge_1.mergeRoundRobin)([a, b]);
    for (let round = 0; round < 5; round += 1) {
        a.deliverNext(round);
        b.deliverNext(round + 100);
        await merged.next();
        await merged.next();
        (0, strict_1.equal)(a.pendingCount, 1);
        (0, strict_1.equal)(b.pendingCount, 1);
    }
    a.finishNext();
    b.finishNext();
    (0, strict_1.deepEqual)(await merged.next(), { value: undefined, done: true });
    (0, strict_1.equal)(a.maxInFlight, 1);
    (0, strict_1.equal)(b.maxInFlight, 1);
});
(0, node_test_1.test)("return 与 next 竞争：已交付项优先，其余预取释放", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const c = new ControlledSource();
    const merged = (0, merge_1.mergeRoundRobin)([a, b, c]);
    a.deliverNext("a0"); // 只有 a 的预取已就绪（已交付）
    await tick();
    const racedNext = merged.next();
    const returned = merged.return();
    (0, strict_1.deepEqual)(await racedNext, { value: "a0", done: false }); // 已交付项优先
    (0, strict_1.deepEqual)(await returned, { value: undefined, done: true });
    // 其余预取被释放：三个源都恰好关闭一次
    (0, strict_1.equal)(a.closeCount, 1);
    (0, strict_1.equal)(b.closeCount, 1);
    (0, strict_1.equal)(c.closeCount, 1);
    (0, strict_1.deepEqual)(await merged.next(), { value: undefined, done: true });
});
(0, node_test_1.test)("重复关闭幂等，资源计数不重复", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const merged = (0, merge_1.mergeRoundRobin)([a, b]);
    const [r1, r2, r3] = await Promise.all([merged.return(), merged.return(), merged.return()]);
    (0, strict_1.deepEqual)(r1, { value: undefined, done: true });
    (0, strict_1.deepEqual)(r2, { value: undefined, done: true });
    (0, strict_1.deepEqual)(r3, { value: undefined, done: true });
    (0, strict_1.deepEqual)(await merged.return(), { value: undefined, done: true });
    (0, strict_1.equal)(a.openCount, 1);
    (0, strict_1.equal)(b.openCount, 1);
    (0, strict_1.equal)(a.closeCount, 1);
    (0, strict_1.equal)(b.closeCount, 1);
});
(0, node_test_1.test)("源抛错只关闭该源并报告，其余源继续轮转", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const c = new ControlledSource();
    const errors = [];
    const merged = (0, merge_1.mergeRoundRobin)([a, b, c], (error, index) => {
        errors.push({ error, index });
    });
    const boom = new Error("boom");
    a.deliverNext("a0");
    b.failNext(boom);
    c.deliverNext("c0");
    await tick();
    (0, strict_1.deepEqual)(await merged.next(), { value: "a0", done: false });
    (0, strict_1.deepEqual)(await merged.next(), { value: "c0", done: false }); // b 被跳过
    (0, strict_1.equal)(errors.length, 1);
    (0, strict_1.equal)(errors[0].error, boom);
    (0, strict_1.equal)(errors[0].index, 1);
    (0, strict_1.equal)(b.closeCount, 1); // 出错源被关闭一次
    // 剩余源继续轮转
    a.deliverNext("a1");
    c.deliverNext("c1");
    (0, strict_1.deepEqual)(await merged.next(), { value: "a1", done: false });
    (0, strict_1.deepEqual)(await merged.next(), { value: "c1", done: false });
    // 关闭合并器不会重复关闭已出错的源
    await merged.return();
    (0, strict_1.equal)(a.closeCount, 1);
    (0, strict_1.equal)(b.closeCount, 1);
    (0, strict_1.equal)(c.closeCount, 1);
});
(0, node_test_1.test)("自然耗尽的源不重复关闭，资源计数平衡", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const merged = (0, merge_1.mergeRoundRobin)([a, b]);
    a.deliverNext(1);
    b.deliverNext(2);
    (0, strict_1.deepEqual)(await merged.next(), { value: 1, done: false });
    (0, strict_1.deepEqual)(await merged.next(), { value: 2, done: false });
    a.finishNext();
    b.finishNext();
    (0, strict_1.deepEqual)(await merged.next(), { value: undefined, done: true });
    // 自然耗尽的源无需再 return()
    (0, strict_1.equal)(a.closeCount, 0);
    (0, strict_1.equal)(b.closeCount, 0);
    // 关闭合并器也不会重复关闭它们
    await merged.return();
    (0, strict_1.equal)(a.closeCount, 0);
    (0, strict_1.equal)(b.closeCount, 0);
    (0, strict_1.equal)(a.openCount, 1);
    (0, strict_1.equal)(b.openCount, 1);
});
(0, node_test_1.test)("for await 与异步生成器互操作", async () => {
    async function* gen(values) {
        for (const value of values)
            yield value;
    }
    const merged = (0, merge_1.mergeRoundRobin)([gen([1, 2]), gen([10, 20, 30])]);
    const out = [];
    for await (const value of merged)
        out.push(value);
    (0, strict_1.deepEqual)(out, [1, 10, 2, 20, 30]);
});
(0, node_test_1.test)("生成器源抛错：报告后继续，for await 正常结束", async () => {
    async function* good() {
        yield 1;
        yield 2;
        yield 3;
    }
    async function* bad() {
        yield 10;
        throw new Error("bad source");
    }
    const errors = [];
    const merged = (0, merge_1.mergeRoundRobin)([good(), bad()], (error) => {
        errors.push(error);
    });
    const out = [];
    for await (const value of merged)
        out.push(value);
    (0, strict_1.deepEqual)(out, [1, 10, 2, 3]);
    (0, strict_1.equal)(errors.length, 1);
});
