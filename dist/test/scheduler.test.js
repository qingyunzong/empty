"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = __importDefault(require("node:assert"));
const scheduler_1 = require("../src/scheduler");
const ev = (id, priority, deps = [], metadata = {}) => ({ id, priority, deps, metadata });
(0, node_test_1.test)("候选必须依赖全满足: 高优先级不能越过因果", () => {
    // B 优先级最高, 但依赖 A; A 必须先交付。
    const plan = (0, scheduler_1.planDeliveries)([
        ev("A", 1),
        ev("B", 99, ["A"]),
        ev("C", 50),
    ]);
    node_assert_1.default.deepStrictEqual(plan.deliveries.map((d) => d.eventId), ["C", "A", "B"]);
});
(0, node_test_1.test)("候选间排序: 优先级高者优先, 并列则 ID 小者优先", () => {
    const plan = (0, scheduler_1.planDeliveries)([
        ev("c", 5),
        ev("a", 5),
        ev("b", 9),
        ev("d", 1),
    ]);
    node_assert_1.default.deepStrictEqual(plan.deliveries.map((x) => x.eventId), ["b", "a", "c", "d"]);
});
(0, node_test_1.test)("取消事件: 传递后继被阻塞, 元数据保留", () => {
    const plan = (0, scheduler_1.planDeliveries)([
        ev("A", 1, [], { title: "root" }),
        ev("B", 2, ["A"], { title: "mid" }),
        ev("C", 3, ["B"], { title: "leaf" }),
        ev("D", 4, [], { title: "free" }),
    ], ["A"]);
    node_assert_1.default.deepStrictEqual(plan.deliveries.map((d) => d.eventId), ["D"]);
    node_assert_1.default.deepStrictEqual(plan.cancelled, [
        { eventId: "A", metadata: { title: "root" } },
    ]);
    node_assert_1.default.deepStrictEqual(plan.blocked.map((b) => b.eventId), ["B", "C"]);
    // 阻塞链: A->B 与 A->B->C。
    const bChains = plan.blocked.find((b) => b.eventId === "B");
    node_assert_1.default.deepStrictEqual(bChains.reason, "cancelled-dependency");
    node_assert_1.default.deepStrictEqual(bChains.chains.map((c) => c.path), [["A", "B"]]);
    node_assert_1.default.deepStrictEqual(bChains.metadata, { title: "mid" });
    const cChains = plan.blocked.find((b) => b.eventId === "C");
    node_assert_1.default.deepStrictEqual(cChains.chains.map((c) => c.path), [["A", "B", "C"]]);
});
(0, node_test_1.test)("菱形依赖的阻塞链包含全部路径", () => {
    const plan = (0, scheduler_1.planDeliveries)([
        ev("X", 1),
        ev("P", 1, ["X"]),
        ev("Q", 1, ["X"]),
        ev("R", 1, ["P", "Q"]),
    ], ["X"]);
    const r = plan.blocked.find((b) => b.eventId === "R");
    node_assert_1.default.deepStrictEqual(r.chains.map((c) => c.path), [
        ["X", "P", "R"],
        ["X", "Q", "R"],
    ]);
});
(0, node_test_1.test)("交付证书: 序号连续, 依赖交付序号正确", () => {
    const plan = (0, scheduler_1.planDeliveries)([
        ev("A", 1),
        ev("B", 1),
        ev("C", 1, ["A", "B"]),
    ]);
    node_assert_1.default.deepStrictEqual(plan.deliveries.map((d) => d.sequence), [0, 1, 2]);
    const certC = plan.deliveries[2];
    node_assert_1.default.strictEqual(certC.eventId, "C");
    node_assert_1.default.deepStrictEqual([...certC.satisfiedDeps].sort((x, y) => x.depId.localeCompare(y.depId)), [
        { depId: "A", deliveredAt: 0 },
        { depId: "B", deliveredAt: 1 },
    ]);
});
(0, node_test_1.test)("依赖环: 环上及依赖环的事件被阻塞", () => {
    const plan = (0, scheduler_1.planDeliveries)([
        ev("A", 1, ["C"]),
        ev("B", 1, ["A"]),
        ev("C", 1, ["B"]),
        ev("D", 1, ["A"]),
        ev("E", 1),
    ]);
    node_assert_1.default.deepStrictEqual(plan.deliveries.map((d) => d.eventId), ["E"]);
    node_assert_1.default.deepStrictEqual(plan.blocked.map((b) => b.eventId), ["A", "B", "C", "D"]);
    for (const b of plan.blocked) {
        node_assert_1.default.strictEqual(b.reason, "dependency-cycle");
        node_assert_1.default.ok(b.chains.length >= 1);
        node_assert_1.default.strictEqual(b.chains[0].rootCause.kind, "cycle");
    }
});
(0, node_test_1.test)("输入校验: 重复 ID / 未知依赖 / 未知取消", () => {
    node_assert_1.default.throws(() => (0, scheduler_1.planDeliveries)([ev("A", 1), ev("A", 2)]), /duplicate/);
    node_assert_1.default.throws(() => (0, scheduler_1.planDeliveries)([ev("A", 1, ["ZZZ"])]), /unknown event/);
    node_assert_1.default.throws(() => (0, scheduler_1.planDeliveries)([ev("A", 1)], ["ZZZ"]), /not found/);
});
(0, node_test_1.test)("确定性: 同一输入两次调度结果完全一致", () => {
    const events = [
        ev("A", 3),
        ev("B", 3, ["A"]),
        ev("C", 7),
        ev("D", 7, ["C"]),
        ev("E", 1, ["B", "D"]),
    ];
    node_assert_1.default.deepStrictEqual((0, scheduler_1.planDeliveries)(events), (0, scheduler_1.planDeliveries)(events));
});
