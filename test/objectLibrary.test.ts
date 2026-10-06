import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import {
  ObjectLibrary,
  QuotaExceededError,
  ReservationExceededError,
  TenantQuotaLedger,
  TerminalStateError,
} from "../src/index";

function setup(limit = 1000) {
  const ledger = new TenantQuotaLedger();
  ledger.setLimit("t1", limit);
  const library = new ObjectLibrary(ledger);
  return { ledger, library };
}

test("开启会话先按最大上传量预留，预留不足则失败且无会话", () => {
  const { ledger, library } = setup(100);

  const session = library.beginUpload({ tenantId: "t1", objectKey: "a.bin", maxBytes: 60 });
  equal(ledger.snapshot("t1").reservedBytes, 60);
  equal(session.state, "open");

  throws(
    () => library.beginUpload({ tenantId: "t1", objectKey: "b.bin", maxBytes: 41 }),
    (err) => err instanceof QuotaExceededError,
  );
  equal(ledger.snapshot("t1").reservedBytes, 60);
});

test("发布累计超过预留即被拒绝，会话保持 open", () => {
  const { library } = setup();
  const session = library.beginUpload({ tenantId: "t1", objectKey: "a.bin", maxBytes: 100 });

  session.publish(40);
  session.publish(60);
  equal(session.publishedBytes, 100);

  throws(
    () => session.publish(1),
    (err) => err instanceof ReservationExceededError,
  );
  equal(session.state, "open");
  equal(session.publishedBytes, 100);
});

test("结束按实际量结算：差额归还，实际量计入已用", () => {
  const { ledger, library } = setup();
  const session = library.beginUpload({ tenantId: "t1", objectKey: "a.bin", maxBytes: 100 });
  session.publish(30);
  session.publish(45);

  const receipt = library.commit(session);
  deepEqual(receipt, {
    sessionId: session.id,
    tenantId: "t1",
    objectKey: "a.bin",
    reservedBytes: 100,
    committedBytes: 75,
    returnedBytes: 25,
  });
  equal(session.state, "finished");
  deepEqual(
    { reserved: ledger.snapshot("t1").reservedBytes, used: ledger.snapshot("t1").usedBytes },
    { reserved: 0, used: 75 },
  );
  equal(library.committedObjects().length, 1);
  equal(library.committedObjects()[0]?.bytes, 75);
});

test("取消全额归还预留，已发布量不计入已用", () => {
  const { ledger, library } = setup();
  const session = library.beginUpload({ tenantId: "t1", objectKey: "a.bin", maxBytes: 100 });
  session.publish(70);

  session.cancel();
  equal(session.state, "cancelled");
  deepEqual(
    { reserved: ledger.snapshot("t1").reservedBytes, used: ledger.snapshot("t1").usedBytes },
    { reserved: 0, used: 0 },
  );
});

test("取消和结束只能一个终态：终态后一切终态操作被拒绝", () => {
  const { library } = setup();

  const finished = library.beginUpload({ tenantId: "t1", objectKey: "a.bin", maxBytes: 10 });
  finished.finish();
  throws(() => finished.finish(), (err) => err instanceof TerminalStateError);
  throws(() => finished.cancel(), (err) => err instanceof TerminalStateError);
  throws(() => finished.publish(1), (err) => err instanceof TerminalStateError);

  const cancelled = library.beginUpload({ tenantId: "t1", objectKey: "b.bin", maxBytes: 10 });
  cancelled.cancel();
  throws(() => cancelled.cancel(), (err) => err instanceof TerminalStateError);
  throws(() => cancelled.finish(), (err) => err instanceof TerminalStateError);
  throws(() => cancelled.publish(1), (err) => err instanceof TerminalStateError);
});

test("终态互斥下额度不被重复归还", () => {
  const { ledger, library } = setup(100);
  const session = library.beginUpload({ tenantId: "t1", objectKey: "a.bin", maxBytes: 100 });
  session.publish(40);
  session.finish();

  throws(() => session.cancel(), (err) => err instanceof TerminalStateError);
  deepEqual(
    { reserved: ledger.snapshot("t1").reservedBytes, used: ledger.snapshot("t1").usedBytes },
    { reserved: 0, used: 40 },
  );
});
