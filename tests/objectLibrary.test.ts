import test from "node:test";
import assert from "node:assert/strict";
import { TenantQuota } from "../src/quota.js";
import { ObjectLibrary } from "../src/objectLibrary.js";
import {
  InvalidStateTransitionError,
  PublishRejectedError,
} from "../src/errors.js";

function setup(limit = 1000) {
  const quota = new TenantQuota(limit);
  const library = new ObjectLibrary(quota);
  return { quota, library };
}

test("开启上传按最大量预留", () => {
  const { quota, library } = setup();
  const session = library.beginUpload("obj-a", 400);
  assert.equal(session.state, "active");
  assert.equal(session.reservedBytes, 400);
  assert.equal(quota.reserved, 400);
  assert.equal(quota.available, 600);
});

test("结束按实际量结算，差额退回", () => {
  const { quota, library } = setup();
  const session = library.beginUpload("obj-a", 400);
  const done = library.finish(session.id, 250);

  assert.equal(done.state, "finished");
  assert.equal(done.settledBytes, 250);
  assert.equal(quota.used, 250);
  assert.equal(quota.reserved, 0);
  assert.equal(quota.available, 750);
});

test("实际量超预留拒绝发布，会话保持在途且额度不变", () => {
  const { quota, library } = setup();
  const session = library.beginUpload("obj-a", 100);

  assert.throws(() => library.finish(session.id, 101), PublishRejectedError);
  assert.equal(library.getSession(session.id).state, "active");
  assert.equal(quota.reserved, 100);
  assert.equal(quota.used, 0);

  const done = library.finish(session.id, 100);
  assert.equal(done.state, "finished");
  assert.equal(quota.used, 100);
});

test("取消退回整笔预留", () => {
  const { quota, library } = setup();
  const session = library.beginUpload("obj-a", 300);
  library.cancel(session.id);
  assert.equal(quota.reserved, 0);
  assert.equal(quota.used, 0);
  assert.equal(quota.available, 1000);
});

test("取消与结束只能一个终态：结束后不可取消", () => {
  const { quota, library } = setup();
  const session = library.beginUpload("obj-a", 100);
  library.finish(session.id, 60);
  assert.throws(() => library.cancel(session.id), InvalidStateTransitionError);
  assert.equal(quota.used, 60);
  assert.equal(quota.reserved, 0);
});

test("取消与结束只能一个终态：取消后不可结束，也不可重复取消", () => {
  const { quota, library } = setup();
  const session = library.beginUpload("obj-a", 100);
  library.cancel(session.id);
  assert.throws(() => library.finish(session.id, 50), InvalidStateTransitionError);
  assert.throws(() => library.cancel(session.id), InvalidStateTransitionError);
  assert.equal(quota.reserved, 0, "额度只归还一次");
});

test("同对象重新开启上传：旧会话作废且额度只归还一次", () => {
  const { quota, library } = setup();
  const first = library.beginUpload("obj-a", 200);
  const second = library.beginUpload("obj-a", 300);

  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.equal(library.getSession(first.id).state, "cancelled");
  assert.equal(quota.reserved, 300, "旧预留已释放，仅新预留占用");

  assert.throws(() => library.cancel(first.id), InvalidStateTransitionError);
  assert.equal(quota.reserved, 300, "旧代际取消不再归还额度");

  library.finish(second.id, 120);
  assert.equal(quota.used, 120);
  assert.equal(quota.reserved, 0);
});
