"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const engine_1 = require("../src/engine");
const model_1 = require("../src/model");
function bootstrap() {
    const world = (0, model_1.initialWorld)();
    (0, engine_1.append)(world, { kind: "StockReceived", material: "steel", qty: 50 });
    (0, engine_1.append)(world, { kind: "EquipmentRegistered", equipment: "press-1" });
    (0, engine_1.append)(world, {
        kind: "OrderPlaced",
        order: "A",
        stages: [
            { name: "cut", materials: { steel: 10 }, equipment: "press-1", recovery: { steel: 0.5 } },
            { name: "form", materials: { steel: 4 }, equipment: "press-1", recovery: { steel: 1 } },
        ],
    });
    return world;
}
(0, node_test_1.default)("开工占用原料与设备", () => {
    const world = bootstrap();
    (0, engine_1.append)(world, { kind: "StageStarted", order: "A", stage: "cut" });
    strict_1.default.equal(world.materials["steel"]?.onHand, 40);
    strict_1.default.equal(world.materials["steel"]?.held, 10);
    strict_1.default.deepEqual(world.equipment["press-1"]?.busyBy, { order: "A", stage: "cut" });
});
(0, node_test_1.default)("失败按阶段回收率决定可回收原料", () => {
    const world = bootstrap();
    (0, engine_1.append)(world, { kind: "StageStarted", order: "A", stage: "cut" });
    (0, engine_1.append)(world, { kind: "StageFailed", order: "A", stage: "cut" });
    const steel = world.materials["steel"];
    strict_1.default.equal(steel?.retained, 5);
    strict_1.default.equal(steel?.lost, 5);
    strict_1.default.equal(steel?.held, 0);
    strict_1.default.equal(world.equipment["press-1"]?.busyBy, null);
});
(0, node_test_1.default)("重试只补差量，不重复消耗已保留料", () => {
    const world = bootstrap();
    (0, engine_1.append)(world, { kind: "StageStarted", order: "A", stage: "cut" });
    (0, engine_1.append)(world, { kind: "StageFailed", order: "A", stage: "cut" });
    const onHandBefore = world.materials["steel"]?.onHand ?? 0;
    (0, engine_1.append)(world, { kind: "StageRetried", order: "A", stage: "cut" });
    const steel = world.materials["steel"];
    strict_1.default.equal(steel?.onHand, onHandBefore - 5);
    strict_1.default.equal(steel?.retained, 0);
    strict_1.default.equal(steel?.held, 10);
    const retryEntries = world.ledger.filter((e) => e.reason.startsWith("retry-"));
    strict_1.default.deepEqual(retryEntries.map((e) => [e.from, e.to, e.qty]), [
        ["retained", "held", 5],
        ["onHand", "held", 5],
    ]);
});
(0, node_test_1.default)("未失败不能重试，未开工不能完工", () => {
    const world = bootstrap();
    strict_1.default.throws(() => (0, engine_1.append)(world, { kind: "StageRetried", order: "A", stage: "cut" }), (err) => err instanceof engine_1.DomainError && /不能重试/.test(err.message));
    strict_1.default.throws(() => (0, engine_1.append)(world, { kind: "StageCompleted", order: "A", stage: "cut" }), (err) => err instanceof engine_1.DomainError && /不能完工/.test(err.message));
});
(0, node_test_1.default)("整单取消产生逆向补料并释放占用", () => {
    const world = bootstrap();
    (0, engine_1.append)(world, { kind: "StageStarted", order: "A", stage: "cut" });
    (0, engine_1.append)(world, { kind: "StageFailed", order: "A", stage: "cut" });
    (0, engine_1.append)(world, { kind: "StageRetried", order: "A", stage: "cut" });
    (0, engine_1.append)(world, { kind: "StageCompleted", order: "A", stage: "cut" });
    (0, engine_1.append)(world, { kind: "StageStarted", order: "A", stage: "form" });
    (0, engine_1.append)(world, { kind: "StageFailed", order: "A", stage: "form" });
    (0, engine_1.append)(world, { kind: "OrderCancelled", order: "A" });
    const steel = world.materials["steel"];
    strict_1.default.equal(steel?.consumed, 10);
    strict_1.default.equal(steel?.reversed, 4);
    strict_1.default.equal(steel?.onHand, 50 - 10 - 5);
    strict_1.default.equal(world.orders["A"]?.status, "cancelled");
    strict_1.default.equal(world.equipment["press-1"]?.busyBy, null);
    const reverse = world.ledger.filter((e) => e.reason === "reverse-replenishment");
    strict_1.default.deepEqual(reverse.map((e) => [e.material, e.from, e.to, e.qty]), [["steel", "retained", "onHand", 4]]);
});
(0, node_test_1.default)("库存不足与设备占用被拒绝", () => {
    const world = (0, model_1.initialWorld)();
    (0, engine_1.append)(world, { kind: "StockReceived", material: "steel", qty: 3 });
    (0, engine_1.append)(world, { kind: "EquipmentRegistered", equipment: "press-1" });
    (0, engine_1.append)(world, {
        kind: "OrderPlaced",
        order: "A",
        stages: [{ name: "cut", materials: { steel: 10 }, equipment: "press-1", recovery: {} }],
    });
    strict_1.default.throws(() => (0, engine_1.append)(world, { kind: "StageStarted", order: "A", stage: "cut" }), engine_1.DomainError);
    const busy = bootstrap();
    (0, engine_1.append)(busy, {
        kind: "OrderPlaced",
        order: "B",
        stages: [{ name: "cut", materials: { steel: 1 }, equipment: "press-1", recovery: {} }],
    });
    (0, engine_1.append)(busy, { kind: "StageStarted", order: "A", stage: "cut" });
    strict_1.default.throws(() => (0, engine_1.append)(busy, { kind: "StageStarted", order: "B", stage: "cut" }), (err) => err instanceof engine_1.DomainError && /占用/.test(err.message));
});
(0, node_test_1.default)("前置阶段未完工不能开工", () => {
    const world = bootstrap();
    strict_1.default.throws(() => (0, engine_1.append)(world, { kind: "StageStarted", order: "A", stage: "form" }), (err) => err instanceof engine_1.DomainError && /前置阶段/.test(err.message));
});
(0, node_test_1.default)("失败事件序号连续且显式", () => {
    const world = bootstrap();
    const first = (0, engine_1.append)(world, { kind: "StageStarted", order: "A", stage: "cut" });
    const second = (0, engine_1.append)(world, { kind: "StageCompleted", order: "A", stage: "cut" });
    strict_1.default.equal(second.seq, first.seq + 1);
    strict_1.default.equal(world.seq, 5);
});
(0, node_test_1.default)("重放校验事件顺序断裂", () => {
    const events = [
        { kind: "StockReceived", material: "steel", qty: 5, seq: 1 },
        { kind: "StockReceived", material: "steel", qty: 5, seq: 3 },
    ];
    strict_1.default.throws(() => (0, engine_1.replay)(events), (err) => err instanceof engine_1.DomainError && /顺序断裂/.test(err.message));
});
