import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import {
  ControlledUploadAdapter,
  ObjectLibrary,
  StaleGenerationError,
  TenantQuotaLedger,
  TerminalStateError,
} from "../src/index";

function setup(limit = 1000) {
  const ledger = new TenantQuotaLedger();
  ledger.setLimit("t1", limit);
  const library = new ObjectLibrary(ledger);
  const adapter = new ControlledUploadAdapter(library);
  return { ledger, library, adapter };
}

function quota(ledger: TenantQuotaLedger) {
  const snap = ledger.snapshot("t1");
  return { reserved: snap.reservedBytes, used: snap.usedBytes };
}

test("开启新代际自动取消旧代际，旧预留恰好归还一次", () => {
  const { ledger, adapter } = setup();
  const gen1 = adapter.start("t1", "a.bin", 100);
  gen1.write(30);
  equal(ledger.snapshot("t1").reservedBytes, 100);

  const gen2 = adapter.start("t1", "a.bin", 50);
  equal(gen1.isStale, true);
  equal(gen1.state, "cancelled");
  equal(adapter.currentGeneration("t1", "a.bin"), 2);
  deepEqual(quota(ledger), { reserved: 50, used: 0 }, "旧代际 100B 归还且仅归还一次");

  gen2.write(50);
  const receipt = gen2.finish();
  equal(receipt.committedBytes, 50);
  deepEqual(quota(ledger), { reserved: 0, used: 50 });
});

test("旧代际句柄的写与结算被拒绝，取消为空操作", () => {
  const { ledger, adapter } = setup();
  const gen1 = adapter.start("t1", "a.bin", 100);
  gen1.write(10);
  adapter.start("t1", "a.bin", 80);

  throws(() => gen1.write(1), (err) => err instanceof StaleGenerationError);
  throws(() => gen1.finish(), (err) => err instanceof StaleGenerationError);
  gen1.cancel();
  gen1.cancel();
  deepEqual(quota(ledger), { reserved: 80, used: 0 }, "取消不重复归还额度");
});

test("finish 幂等：重复结束返回同一回执，额度恰好结算一次", () => {
  const { ledger, library, adapter } = setup();
  const handle = adapter.start("t1", "a.bin", 100);
  handle.write(64);

  const first = handle.finish();
  const second = handle.finish();
  equal(second, first);
  deepEqual(quota(ledger), { reserved: 0, used: 64 });
  equal(library.committedObjects().length, 1, "成品对象只登记一次");
});

test("cancel 幂等：重复取消只归还一次额度", () => {
  const { ledger, adapter } = setup();
  const handle = adapter.start("t1", "a.bin", 100);
  handle.write(20);

  handle.cancel();
  handle.cancel();
  handle.cancel();
  deepEqual(quota(ledger), { reserved: 0, used: 0 });
});

test("句柄层同样保证取消和结束只能一个终态", () => {
  const { adapter } = setup();

  const cancelled = adapter.start("t1", "a.bin", 10);
  cancelled.cancel();
  throws(() => cancelled.finish(), (err) => err instanceof TerminalStateError);

  const finished = adapter.start("t1", "b.bin", 10);
  finished.finish();
  throws(() => finished.cancel(), (err) => err instanceof TerminalStateError);
});

test("多对象键互不影响，代际按键独立递增", () => {
  const { ledger, adapter } = setup();
  const a1 = adapter.start("t1", "a.bin", 100);
  const b1 = adapter.start("t1", "b.bin", 200);
  equal(a1.generation, 1);
  equal(b1.generation, 1);

  const a2 = adapter.start("t1", "a.bin", 100);
  equal(a2.generation, 2);
  equal(b1.isStale, false, "b.bin 的句柄不受 a.bin 换代影响");
  deepEqual(quota(ledger), { reserved: 300, used: 0 });
});

test("取代 + 显式取消 + 重复结束叠加后账本仍精确", () => {
  const { ledger, adapter } = setup(300);
  const gen1 = adapter.start("t1", "a.bin", 120);
  gen1.write(70);

  const gen2 = adapter.start("t1", "a.bin", 150);
  gen1.cancel();
  throws(() => gen1.finish(), (err) => err instanceof StaleGenerationError);

  gen2.write(150);
  gen2.finish();
  gen2.finish();
  gen1.cancel();

  deepEqual(quota(ledger), { reserved: 0, used: 150 });
});
