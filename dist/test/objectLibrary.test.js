"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const index_1 = require("../src/index");
function setup(limit = 1000) {
    const ledger = new index_1.TenantQuotaLedger();
    ledger.setLimit("t1", limit);
    const library = new index_1.ObjectLibrary(ledger);
    return { ledger, library };
}
(0, node_test_1.test)("开启会话先按最大上传量预留，预留不足则失败且无会话", () => {
    const { ledger, library } = setup(100);
    const session = library.beginUpload({ tenantId: "t1", objectKey: "a.bin", maxBytes: 60 });
    (0, strict_1.equal)(ledger.snapshot("t1").reservedBytes, 60);
    (0, strict_1.equal)(session.state, "open");
    (0, strict_1.throws)(() => library.beginUpload({ tenantId: "t1", objectKey: "b.bin", maxBytes: 41 }), (err) => err instanceof index_1.QuotaExceededError);
    (0, strict_1.equal)(ledger.snapshot("t1").reservedBytes, 60);
});
(0, node_test_1.test)("发布累计超过预留即被拒绝，会话保持 open", () => {
    const { library } = setup();
    const session = library.beginUpload({ tenantId: "t1", objectKey: "a.bin", maxBytes: 100 });
    session.publish(40);
    session.publish(60);
    (0, strict_1.equal)(session.publishedBytes, 100);
    (0, strict_1.throws)(() => session.publish(1), (err) => err instanceof index_1.ReservationExceededError);
    (0, strict_1.equal)(session.state, "open");
    (0, strict_1.equal)(session.publishedBytes, 100);
});
(0, node_test_1.test)("结束按实际量结算：差额归还，实际量计入已用", () => {
    const { ledger, library } = setup();
    const session = library.beginUpload({ tenantId: "t1", objectKey: "a.bin", maxBytes: 100 });
    session.publish(30);
    session.publish(45);
    const receipt = library.commit(session);
    (0, strict_1.deepEqual)(receipt, {
        sessionId: session.id,
        tenantId: "t1",
        objectKey: "a.bin",
        reservedBytes: 100,
        committedBytes: 75,
        returnedBytes: 25,
    });
    (0, strict_1.equal)(session.state, "finished");
    (0, strict_1.deepEqual)({ reserved: ledger.snapshot("t1").reservedBytes, used: ledger.snapshot("t1").usedBytes }, { reserved: 0, used: 75 });
    (0, strict_1.equal)(library.committedObjects().length, 1);
    (0, strict_1.equal)(library.committedObjects()[0]?.bytes, 75);
});
(0, node_test_1.test)("取消全额归还预留，已发布量不计入已用", () => {
    const { ledger, library } = setup();
    const session = library.beginUpload({ tenantId: "t1", objectKey: "a.bin", maxBytes: 100 });
    session.publish(70);
    session.cancel();
    (0, strict_1.equal)(session.state, "cancelled");
    (0, strict_1.deepEqual)({ reserved: ledger.snapshot("t1").reservedBytes, used: ledger.snapshot("t1").usedBytes }, { reserved: 0, used: 0 });
});
(0, node_test_1.test)("取消和结束只能一个终态：终态后一切终态操作被拒绝", () => {
    const { library } = setup();
    const finished = library.beginUpload({ tenantId: "t1", objectKey: "a.bin", maxBytes: 10 });
    finished.finish();
    (0, strict_1.throws)(() => finished.finish(), (err) => err instanceof index_1.TerminalStateError);
    (0, strict_1.throws)(() => finished.cancel(), (err) => err instanceof index_1.TerminalStateError);
    (0, strict_1.throws)(() => finished.publish(1), (err) => err instanceof index_1.TerminalStateError);
    const cancelled = library.beginUpload({ tenantId: "t1", objectKey: "b.bin", maxBytes: 10 });
    cancelled.cancel();
    (0, strict_1.throws)(() => cancelled.cancel(), (err) => err instanceof index_1.TerminalStateError);
    (0, strict_1.throws)(() => cancelled.finish(), (err) => err instanceof index_1.TerminalStateError);
    (0, strict_1.throws)(() => cancelled.publish(1), (err) => err instanceof index_1.TerminalStateError);
});
(0, node_test_1.test)("终态互斥下额度不被重复归还", () => {
    const { ledger, library } = setup(100);
    const session = library.beginUpload({ tenantId: "t1", objectKey: "a.bin", maxBytes: 100 });
    session.publish(40);
    session.finish();
    (0, strict_1.throws)(() => session.cancel(), (err) => err instanceof index_1.TerminalStateError);
    (0, strict_1.deepEqual)({ reserved: ledger.snapshot("t1").reservedBytes, used: ledger.snapshot("t1").usedBytes }, { reserved: 0, used: 40 });
});
