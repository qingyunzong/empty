import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import { QuotaExceededError, TenantQuotaLedger } from "../src/index";

test("预留占用额度，超限预留被拒绝", () => {
  const ledger = new TenantQuotaLedger();
  ledger.setLimit("t1", 1000);

  ledger.reserve("t1", 400);
  deepEqual(ledger.snapshot("t1"), {
    limitBytes: 1000,
    reservedBytes: 400,
    usedBytes: 0,
    availableBytes: 600,
  });

  throws(
    () => ledger.reserve("t1", 601),
    (err) => err instanceof QuotaExceededError,
  );
  equal(ledger.snapshot("t1").reservedBytes, 400);
});

test("结算把预留转成实际用量并归还差额", () => {
  const ledger = new TenantQuotaLedger();
  ledger.setLimit("t1", 1000);
  ledger.reserve("t1", 400);

  ledger.settle("t1", 400, 250);
  deepEqual(ledger.snapshot("t1"), {
    limitBytes: 1000,
    reservedBytes: 0,
    usedBytes: 250,
    availableBytes: 750,
  });
});

test("取消释放全额归还预留", () => {
  const ledger = new TenantQuotaLedger();
  ledger.setLimit("t1", 1000);
  ledger.reserve("t1", 400);

  ledger.release("t1", 400);
  equal(ledger.snapshot("t1").reservedBytes, 0);
  equal(ledger.snapshot("t1").usedBytes, 0);
});

test("租户缩额不撤销已预留，但阻止新的预留", () => {
  const ledger = new TenantQuotaLedger();
  ledger.setLimit("t1", 1000);
  ledger.reserve("t1", 800);

  ledger.setLimit("t1", 500);
  const snap = ledger.snapshot("t1");
  equal(snap.reservedBytes, 800, "已预留量保持不变");
  equal(snap.availableBytes, 0);

  throws(
    () => ledger.reserve("t1", 1),
    (err) => err instanceof QuotaExceededError,
  );

  ledger.settle("t1", 800, 300);
  equal(ledger.snapshot("t1").reservedBytes, 0);
  equal(ledger.snapshot("t1").usedBytes, 300);

  ledger.reserve("t1", 200);
  equal(ledger.snapshot("t1").reservedBytes, 200);
});

test("结算量不得超过预留量，释放量不得超过在途预留", () => {
  const ledger = new TenantQuotaLedger();
  ledger.setLimit("t1", 1000);
  ledger.reserve("t1", 100);

  throws(() => ledger.settle("t1", 100, 101), RangeError);
  throws(() => ledger.settle("t1", 101, 50), RangeError);
  throws(() => ledger.release("t1", 101), RangeError);
});
