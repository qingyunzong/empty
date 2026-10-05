"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const certificate_1 = require("../src/certificate");
const scenario_1 = require("../src/scenario");
(0, node_test_1.default)("canonicalize 键序稳定", () => {
    const a = (0, certificate_1.canonicalize)({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } });
    const b = (0, certificate_1.canonicalize)({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 });
    strict_1.default.equal(a, b);
});
(0, node_test_1.default)("增量状态与从头重放的状态证书一致", () => {
    const { world, replayed, events } = (0, scenario_1.runScenario)();
    const live = (0, certificate_1.certify)(world);
    const replayedCert = (0, certificate_1.certify)(replayed);
    strict_1.default.equal(live.sha256, replayedCert.sha256);
    strict_1.default.equal(live.eventCount, events.length);
    strict_1.default.equal(live.lastSeq, events.length);
});
(0, node_test_1.default)("场景物料账守恒：收货 = 在库 + 在制 + 保留 + 耗用 + 损耗", () => {
    const { world } = (0, scenario_1.runScenario)();
    const received = world.ledger
        .filter((e) => e.reason === "stock-received")
        .reduce((acc, e) => {
        acc[e.material] = (acc[e.material] ?? 0) + e.qty;
        return acc;
    }, {});
    for (const [material, account] of Object.entries(world.materials)) {
        const total = received[material] ?? 0;
        const sum = account.onHand + account.held + account.retained + account.consumed + account.lost;
        strict_1.default.equal(sum, total, `物料 ${material} 账不守恒`);
    }
});
(0, node_test_1.default)("场景关键结果：A 取消、B 完工、保留料未被重复消耗", () => {
    const { world } = (0, scenario_1.runScenario)();
    strict_1.default.equal(world.orders["A"]?.status, "cancelled");
    strict_1.default.equal(world.orders["B"]?.status, "completed");
    const steel = world.materials["steel"];
    strict_1.default.equal(steel?.consumed, 10 + 6 + 8);
    strict_1.default.equal(steel?.lost, 5);
    strict_1.default.equal(steel?.reversed, 0);
    const plastic = world.materials["plastic"];
    strict_1.default.equal(plastic?.lost, 2);
    strict_1.default.equal(plastic?.reversed, 3);
    const retryConsumes = world.ledger.filter((e) => e.reason === "retry-consume-shortfall");
    strict_1.default.deepEqual(retryConsumes.map((e) => [e.material, e.qty]), [["steel", 5]]);
});
