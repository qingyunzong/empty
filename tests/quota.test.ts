import test from "node:test";
import assert from "node:assert/strict";
import { TenantQuota } from "../src/quota.js";
import { QuotaExceededError } from "../src/errors.js";

test("预留占用可用额度，结算后转入已用量", () => {
  const quota = new TenantQuota(1000);
  quota.reserve(400);
  assert.equal(quota.reserved, 400);
  assert.equal(quota.available, 600);

  quota.settle(400, 250);
  assert.equal(quota.reserved, 0);
  assert.equal(quota.used, 250);
  assert.equal(quota.available, 750);
});

test("可用额度不足时拒绝预留且无副作用", () => {
  const quota = new TenantQuota(100);
  quota.reserve(80);
  assert.throws(() => quota.reserve(30), QuotaExceededError);
  assert.equal(quota.reserved, 80);
  assert.equal(quota.available, 20);
});

test("租户缩额不撤销已预留，仅收紧未来预留", () => {
  const quota = new TenantQuota(1000);
  quota.reserve(700);
  quota.shrink(500);

  assert.equal(quota.limit, 500);
  assert.equal(quota.reserved, 700, "已预留量保持不变");
  assert.equal(quota.available, -200, "可用额度可为负，属正常状态");

  assert.throws(() => quota.reserve(1), QuotaExceededError);

  quota.settle(700, 650);
  assert.equal(quota.used, 650);
  assert.equal(quota.reserved, 0);
  assert.throws(() => quota.reserve(1), QuotaExceededError, "缩额后仍不可超新上限");
});

test("取消释放整笔预留", () => {
  const quota = new TenantQuota(100);
  quota.reserve(60);
  quota.release(60);
  assert.equal(quota.reserved, 0);
  assert.equal(quota.available, 100);
});
