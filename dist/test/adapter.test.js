"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const index_1 = require("../src/index");
function setup(limit = 1000) {
    const ledger = new index_1.TenantQuotaLedger();
    ledger.setLimit("t1", limit);
    const library = new index_1.ObjectLibrary(ledger);
    const adapter = new index_1.ControlledUploadAdapter(library);
    return { ledger, library, adapter };
}
function quota(ledger) {
    const snap = ledger.snapshot("t1");
    return { reserved: snap.reservedBytes, used: snap.usedBytes };
}
(0, node_test_1.test)("开启新代际自动取消旧代际，旧预留恰好归还一次", () => {
    const { ledger, adapter } = setup();
    const gen1 = adapter.start("t1", "a.bin", 100);
    gen1.write(30);
    (0, strict_1.equal)(ledger.snapshot("t1").reservedBytes, 100);
    const gen2 = adapter.start("t1", "a.bin", 50);
    (0, strict_1.equal)(gen1.isStale, true);
    (0, strict_1.equal)(gen1.state, "cancelled");
    (0, strict_1.equal)(adapter.currentGeneration("t1", "a.bin"), 2);
    (0, strict_1.deepEqual)(quota(ledger), { reserved: 50, used: 0 }, "旧代际 100B 归还且仅归还一次");
    gen2.write(50);
    const receipt = gen2.finish();
    (0, strict_1.equal)(receipt.committedBytes, 50);
    (0, strict_1.deepEqual)(quota(ledger), { reserved: 0, used: 50 });
});
(0, node_test_1.test)("旧代际句柄的写与结算被拒绝，取消为空操作", () => {
    const { ledger, adapter } = setup();
    const gen1 = adapter.start("t1", "a.bin", 100);
    gen1.write(10);
    adapter.start("t1", "a.bin", 80);
    (0, strict_1.throws)(() => gen1.write(1), (err) => err instanceof index_1.StaleGenerationError);
    (0, strict_1.throws)(() => gen1.finish(), (err) => err instanceof index_1.StaleGenerationError);
    gen1.cancel();
    gen1.cancel();
    (0, strict_1.deepEqual)(quota(ledger), { reserved: 80, used: 0 }, "取消不重复归还额度");
});
(0, node_test_1.test)("finish 幂等：重复结束返回同一回执，额度恰好结算一次", () => {
    const { ledger, library, adapter } = setup();
    const handle = adapter.start("t1", "a.bin", 100);
    handle.write(64);
    const first = handle.finish();
    const second = handle.finish();
    (0, strict_1.equal)(second, first);
    (0, strict_1.deepEqual)(quota(ledger), { reserved: 0, used: 64 });
    (0, strict_1.equal)(library.committedObjects().length, 1, "成品对象只登记一次");
});
(0, node_test_1.test)("cancel 幂等：重复取消只归还一次额度", () => {
    const { ledger, adapter } = setup();
    const handle = adapter.start("t1", "a.bin", 100);
    handle.write(20);
    handle.cancel();
    handle.cancel();
    handle.cancel();
    (0, strict_1.deepEqual)(quota(ledger), { reserved: 0, used: 0 });
});
(0, node_test_1.test)("句柄层同样保证取消和结束只能一个终态", () => {
    const { adapter } = setup();
    const cancelled = adapter.start("t1", "a.bin", 10);
    cancelled.cancel();
    (0, strict_1.throws)(() => cancelled.finish(), (err) => err instanceof index_1.TerminalStateError);
    const finished = adapter.start("t1", "b.bin", 10);
    finished.finish();
    (0, strict_1.throws)(() => finished.cancel(), (err) => err instanceof index_1.TerminalStateError);
});
(0, node_test_1.test)("多对象键互不影响，代际按键独立递增", () => {
    const { ledger, adapter } = setup();
    const a1 = adapter.start("t1", "a.bin", 100);
    const b1 = adapter.start("t1", "b.bin", 200);
    (0, strict_1.equal)(a1.generation, 1);
    (0, strict_1.equal)(b1.generation, 1);
    const a2 = adapter.start("t1", "a.bin", 100);
    (0, strict_1.equal)(a2.generation, 2);
    (0, strict_1.equal)(b1.isStale, false, "b.bin 的句柄不受 a.bin 换代影响");
    (0, strict_1.deepEqual)(quota(ledger), { reserved: 300, used: 0 });
});
(0, node_test_1.test)("取代 + 显式取消 + 重复结束叠加后账本仍精确", () => {
    const { ledger, adapter } = setup(300);
    const gen1 = adapter.start("t1", "a.bin", 120);
    gen1.write(70);
    const gen2 = adapter.start("t1", "a.bin", 150);
    gen1.cancel();
    (0, strict_1.throws)(() => gen1.finish(), (err) => err instanceof index_1.StaleGenerationError);
    gen2.write(150);
    gen2.finish();
    gen2.finish();
    gen1.cancel();
    (0, strict_1.deepEqual)(quota(ledger), { reserved: 0, used: 150 });
});
