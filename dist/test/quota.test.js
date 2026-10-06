"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const index_1 = require("../src/index");
(0, node_test_1.test)("预留占用额度，超限预留被拒绝", () => {
    const ledger = new index_1.TenantQuotaLedger();
    ledger.setLimit("t1", 1000);
    ledger.reserve("t1", 400);
    (0, strict_1.deepEqual)(ledger.snapshot("t1"), {
        limitBytes: 1000,
        reservedBytes: 400,
        usedBytes: 0,
        availableBytes: 600,
    });
    (0, strict_1.throws)(() => ledger.reserve("t1", 601), (err) => err instanceof index_1.QuotaExceededError);
    (0, strict_1.equal)(ledger.snapshot("t1").reservedBytes, 400);
});
(0, node_test_1.test)("结算把预留转成实际用量并归还差额", () => {
    const ledger = new index_1.TenantQuotaLedger();
    ledger.setLimit("t1", 1000);
    ledger.reserve("t1", 400);
    ledger.settle("t1", 400, 250);
    (0, strict_1.deepEqual)(ledger.snapshot("t1"), {
        limitBytes: 1000,
        reservedBytes: 0,
        usedBytes: 250,
        availableBytes: 750,
    });
});
(0, node_test_1.test)("取消释放全额归还预留", () => {
    const ledger = new index_1.TenantQuotaLedger();
    ledger.setLimit("t1", 1000);
    ledger.reserve("t1", 400);
    ledger.release("t1", 400);
    (0, strict_1.equal)(ledger.snapshot("t1").reservedBytes, 0);
    (0, strict_1.equal)(ledger.snapshot("t1").usedBytes, 0);
});
(0, node_test_1.test)("租户缩额不撤销已预留，但阻止新的预留", () => {
    const ledger = new index_1.TenantQuotaLedger();
    ledger.setLimit("t1", 1000);
    ledger.reserve("t1", 800);
    ledger.setLimit("t1", 500);
    const snap = ledger.snapshot("t1");
    (0, strict_1.equal)(snap.reservedBytes, 800, "已预留量保持不变");
    (0, strict_1.equal)(snap.availableBytes, 0);
    (0, strict_1.throws)(() => ledger.reserve("t1", 1), (err) => err instanceof index_1.QuotaExceededError);
    ledger.settle("t1", 800, 300);
    (0, strict_1.equal)(ledger.snapshot("t1").reservedBytes, 0);
    (0, strict_1.equal)(ledger.snapshot("t1").usedBytes, 300);
    ledger.reserve("t1", 200);
    (0, strict_1.equal)(ledger.snapshot("t1").reservedBytes, 200);
});
(0, node_test_1.test)("结算量不得超过预留量，释放量不得超过在途预留", () => {
    const ledger = new index_1.TenantQuotaLedger();
    ledger.setLimit("t1", 1000);
    ledger.reserve("t1", 100);
    (0, strict_1.throws)(() => ledger.settle("t1", 100, 101), RangeError);
    (0, strict_1.throws)(() => ledger.settle("t1", 101, 50), RangeError);
    (0, strict_1.throws)(() => ledger.release("t1", 101), RangeError);
});
