"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const pn_counter_1 = require("../src/pn-counter");
/** 确定性伪随机数（mulberry32），保证测试可复现。 */
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
(0, node_test_1.test)("基本增减与 bigint 大数", () => {
    const counter = new pn_counter_1.PNCounter("A");
    counter.increment(5n);
    counter.decrement(2n);
    (0, strict_1.equal)(counter.value(), 3n);
    const huge = (1n << 80n) + 12345n; // 超出 Number.MAX_SAFE_INTEGER
    counter.increment(huge);
    (0, strict_1.equal)(counter.value(), 3n + huge);
    (0, strict_1.throws)(() => counter.increment(0n));
    (0, strict_1.throws)(() => counter.decrement(-1n));
});
(0, node_test_1.test)("撤回通过新增反向量，旧量保留不删除", () => {
    const counter = new pn_counter_1.PNCounter("A");
    counter.increment(5n);
    counter.undoIncrement(5n);
    (0, strict_1.equal)(counter.value(), 0n);
    // 旧的 inc=5 仍在，只是新增了等量 dec=5，分量本身只增不减。
    (0, strict_1.deepEqual)(counter.componentOf("A", 1), { inc: 5n, dec: 5n });
    counter.decrement(3n);
    counter.undoDecrement(3n);
    (0, strict_1.equal)(counter.value(), 0n);
    (0, strict_1.deepEqual)(counter.componentOf("A", 1), { inc: 8n, dec: 8n });
});
(0, node_test_1.test)("副本重启带新代际，旧代际分量保留", () => {
    const counter = new pn_counter_1.PNCounter("A");
    counter.increment(3n);
    counter.restart();
    (0, strict_1.equal)(counter.currentGeneration, 2);
    counter.increment(2n);
    counter.decrement(10n);
    (0, strict_1.equal)(counter.value(), -5n);
    (0, strict_1.deepEqual)(counter.componentOf("A", 1), { inc: 3n, dec: 0n });
    (0, strict_1.deepEqual)(counter.componentOf("A", 2), { inc: 2n, dec: 10n });
});
(0, node_test_1.test)("合并取分量最大且幂等", () => {
    const a = new pn_counter_1.PNCounter("A");
    const b = new pn_counter_1.PNCounter("B");
    a.increment(4n);
    b.increment(7n);
    b.decrement(1n);
    a.merge(b);
    (0, strict_1.equal)(a.value(), 10n);
    // 重复合并同一份状态，结果不变（幂等）。
    const before = a.snapshot();
    a.merge(b);
    a.merge(b.clone());
    (0, strict_1.deepEqual)(a.snapshot(), before);
    // b 合并 a 后，两边对同一分量取到各自的最大值并收敛。
    b.merge(a);
    (0, strict_1.equal)(b.value(), 10n);
    (0, strict_1.deepEqual)(b.componentOf("A", 1), { inc: 4n, dec: 0n });
    (0, strict_1.deepEqual)(b.componentOf("B", 1), { inc: 7n, dec: 1n });
});
(0, node_test_1.test)("快照序列化/反序列化保持 bigint 精度", () => {
    const a = new pn_counter_1.PNCounter("A");
    a.increment((1n << 90n) + 7n);
    a.restart();
    a.decrement(42n);
    const restored = pn_counter_1.PNCounter.fromSnapshot("B", 1, JSON.parse(JSON.stringify(a.snapshot())));
    (0, strict_1.equal)(restored.value(), a.value());
    (0, strict_1.deepEqual)(restored.componentOf("A", 1), a.componentOf("A", 1));
    (0, strict_1.deepEqual)(restored.componentOf("A", 2), a.componentOf("A", 2));
});
/**
 * 核心性质测试：随机操作序列（含撤回与重启），
 * 乱序 + 重复合并后，所有副本收敛到“完整操作集合求和”。
 */
function convergenceScenario(seed, replicaCount, opCount) {
    const random = mulberry32(seed);
    const replicas = [];
    for (let i = 0; i < replicaCount; i++) {
        replicas.push(new pn_counter_1.PNCounter(`R${i}`));
    }
    // 完整操作集合：每次本地操作都记入全局操作日志，代数和即为真值。
    let expectedSum = 0n;
    for (let i = 0; i < opCount; i++) {
        const replica = replicas[Math.floor(random() * replicaCount)];
        const amount = BigInt(1 + Math.floor(random() * 1000));
        const choice = random();
        if (choice < 0.35) {
            replica.increment(amount);
            expectedSum += amount;
        }
        else if (choice < 0.7) {
            replica.decrement(amount);
            expectedSum -= amount;
        }
        else if (choice < 0.8) {
            replica.undoIncrement(amount); // 撤回 = 新增反向量，代数和同步抵消
            expectedSum -= amount;
        }
        else if (choice < 0.9) {
            replica.undoDecrement(amount);
            expectedSum += amount;
        }
        else {
            replica.restart(); // 重启换代际，不改变计数值
        }
    }
    // 乱序 + 重复合并：每个副本按各自随机顺序、带重复地合并所有副本快照。
    for (const target of replicas) {
        const order = replicas.map((source) => source.clone());
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
        for (const source of order) {
            target.merge(source);
            if (random() < 0.5) {
                target.merge(source); // 重复合并，验证幂等
            }
        }
        // 再随机重复合并几个副本，模拟乱序重传。
        for (let k = 0; k < replicaCount; k++) {
            target.merge(replicas[Math.floor(random() * replicaCount)]);
        }
    }
    for (const replica of replicas) {
        (0, strict_1.equal)(replica.value(), expectedSum, `replica ${replica.replicaId} 未收敛到操作集合求和`);
    }
}
(0, node_test_1.test)("乱序重复合并收敛到完整操作集合求和（多组种子）", () => {
    for (const seed of [1, 7, 42, 1337, 20261006]) {
        convergenceScenario(seed, 4, 200);
    }
});
(0, node_test_1.test)("负结果：减量多于增量时收敛到负的代数和", () => {
    const random = mulberry32(99);
    const a = new pn_counter_1.PNCounter("A");
    const b = new pn_counter_1.PNCounter("B");
    let expected = 0n;
    for (let i = 0; i < 50; i++) {
        const amount = BigInt(1 + Math.floor(random() * 500));
        a.decrement(amount);
        expected -= amount;
        if (i % 7 === 0) {
            b.increment(amount / 3n + 1n);
            expected += amount / 3n + 1n;
        }
        if (i % 11 === 0) {
            a.restart();
        }
    }
    (0, strict_1.ok)(expected < 0n, "该场景应产生负的期望值");
    // 乱序重复合并后仍为负的代数和。
    a.merge(b);
    a.merge(b);
    b.merge(a.clone());
    b.merge(a);
    (0, strict_1.equal)(a.value(), expected);
    (0, strict_1.equal)(b.value(), expected);
    (0, strict_1.ok)(a.value() < 0n);
});
(0, node_test_1.test)("撤回不删除旧量：合并后旧分量依然完整", () => {
    const a = new pn_counter_1.PNCounter("A");
    a.increment(10n);
    a.undoIncrement(10n);
    a.restart();
    a.increment(1n);
    const b = new pn_counter_1.PNCounter("B");
    b.merge(a);
    b.undoIncrement(1n); // B 在自己代际撤回，不影响 A 的分量
    (0, strict_1.equal)(b.value(), 0n);
    (0, strict_1.deepEqual)(b.componentOf("A", 1), { inc: 10n, dec: 10n });
    (0, strict_1.deepEqual)(b.componentOf("A", 2), { inc: 1n, dec: 0n });
    (0, strict_1.deepEqual)(b.componentOf("B", 1), { inc: 0n, dec: 1n });
});
