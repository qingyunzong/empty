import test from "node:test";
import assert from "node:assert/strict";
import { TenantQuota } from "../src/quota.js";
import { ObjectLibrary } from "../src/objectLibrary.js";
import { ControlledUploadAdapter } from "../src/controlledUploadAdapter.js";
import { PublishRejectedError, StaleGenerationError } from "../src/errors.js";

function setup(limit = 1000) {
  const quota = new TenantQuota(limit);
  const library = new ObjectLibrary(quota);
  const adapter = new ControlledUploadAdapter(library);
  return { quota, library, adapter };
}

test("取消幂等：额度归还且仅归还一次", () => {
  const { quota, adapter } = setup();
  const handle = adapter.start("obj-a", 200);

  assert.equal(adapter.cancel(handle), true);
  assert.equal(quota.reserved, 0);

  assert.equal(adapter.cancel(handle), false, "重复取消为无操作");
  assert.equal(quota.reserved, 0, "额度未二次归还");
  assert.equal(quota.available, 1000);
});

test("发布后取消不再归还额度", () => {
  const { quota, adapter } = setup();
  const handle = adapter.start("obj-a", 200);
  adapter.publish(handle, 150);

  assert.equal(adapter.cancel(handle), false);
  assert.equal(quota.used, 150);
  assert.equal(quota.reserved, 0);
});

test("旧代际取消为无操作，不影响新代际预留", () => {
  const { quota, adapter } = setup();
  const stale = adapter.start("obj-a", 200);
  const current = adapter.start("obj-a", 300);

  assert.equal(stale.generation, 1);
  assert.equal(current.generation, 2);
  assert.equal(quota.reserved, 300, "旧会话作废时已归还一次");

  assert.equal(adapter.cancel(stale), false, "旧代际取消被忽略");
  assert.equal(quota.reserved, 300, "新代际预留不受影响");

  adapter.publish(current, 120);
  assert.equal(quota.used, 120);
  assert.equal(quota.reserved, 0);
});

test("旧代际发布被拒绝", () => {
  const { adapter } = setup();
  const stale = adapter.start("obj-a", 100);
  adapter.start("obj-a", 100);
  assert.throws(() => adapter.publish(stale, 10), StaleGenerationError);
});

test("超预留发布被拒绝，可修正后重发", () => {
  const { quota, adapter } = setup();
  const handle = adapter.start("obj-a", 100);

  assert.throws(() => adapter.publish(handle, 500), PublishRejectedError);
  assert.equal(quota.reserved, 100);

  adapter.publish(handle, 90);
  assert.equal(quota.used, 90);
  assert.equal(quota.reserved, 0);
});

test("不同对象句柄互不影响代际判定", () => {
  const { quota, adapter } = setup();
  const a1 = adapter.start("obj-a", 100);
  const b1 = adapter.start("obj-b", 100);
  const a2 = adapter.start("obj-a", 100);

  assert.equal(adapter.cancel(a1), false, "obj-a 旧代际失效");
  assert.equal(adapter.cancel(b1), true, "obj-b 不受影响");
  assert.equal(adapter.cancel(a2), true);
  assert.equal(quota.reserved, 0);
});
