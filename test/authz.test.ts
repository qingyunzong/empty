import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AuthorizationError,
  DataStore,
  EvidenceLog,
  PolicyStore,
  openSession,
} from "../src/index.js";

function fixture() {
  const policy = new PolicyStore();
  const store = new DataStore();
  const log = new EvidenceLog();
  policy.grant({ subject: "alice", action: "read", resource: "doc/A" });
  policy.grant({ subject: "alice", action: "write", resource: "doc/A" });
  policy.grant({ subject: "alice", action: "read", resource: "doc/B" });
  policy.grant({ subject: "alice", action: "write", resource: "doc/B" });
  return { policy, store, log };
}

describe("快照绑定", () => {
  test("会话绑定创建时的策略版本", () => {
    const { policy, store, log } = fixture();
    const session = openSession("alice", policy, store, log);
    assert.equal(session.boundVersion, policy.latestVersion);
    policy.revoke({ subject: "alice", action: "write", resource: "doc/B" });
    assert.equal(session.boundVersion, policy.latestVersion - 1);
  });

  test("长事务读在权限被撤销后仍按旧快照放行", () => {
    const { policy, store, log } = fixture();
    const session = openSession("alice", policy, store, log);
    const tx = session.beginTransaction();
    policy.revoke({ subject: "alice", action: "read", resource: "doc/B" });
    assert.doesNotThrow(() => tx.read("doc/B"));
    const hit = log.all().at(-1);
    assert.equal(hit?.decision, "allow");
    assert.equal(hit?.checkedVersion, session.boundVersion);
    assert.ok(hit !== undefined && hit.checkedVersion < hit.latestVersion);
  });

  test("新会话绑定最新版本，已撤销的读权限立即被拒", () => {
    const { policy, store, log } = fixture();
    policy.revoke({ subject: "alice", action: "read", resource: "doc/B" });
    const session = openSession("alice", policy, store, log);
    const tx = session.beginTransaction();
    assert.throws(() => tx.read("doc/B"), AuthorizationError);
  });
});

describe("提交重核", () => {
  test("提交按最新版本重核：撤销写权限后整体中止，一条都不落库", () => {
    const { policy, store, log } = fixture();
    const session = openSession("alice", policy, store, log);
    const tx = session.beginTransaction();
    tx.write("doc/A", "a1"); // doc/A 写权限始终有效
    tx.write("doc/B", "b1"); // 缓冲时 v4 放行
    policy.revoke({ subject: "alice", action: "write", resource: "doc/B" });

    const result = tx.commit();
    assert.equal(result.status, "aborted");
    if (result.status === "aborted") {
      assert.equal(result.recheckedVersion, policy.latestVersion);
      assert.deepEqual(
        result.failures.map((f) => f.resource),
        ["doc/B"],
      );
    }
    // 失败全不提交：连仍然合法的 doc/A 也不能落库
    assert.deepEqual(store.entries(), {});
  });

  test("策略未变化时提交成功，全部写动作落库", () => {
    const { policy, store, log } = fixture();
    const session = openSession("alice", policy, store, log);
    const tx = session.beginTransaction();
    tx.write("doc/A", "a1");
    tx.write("doc/B", "b1");
    const result = tx.commit();
    assert.equal(result.status, "committed");
    assert.deepEqual(store.entries(), { "doc/A": "a1", "doc/B": "b1" });
  });

  test("撤销与提交交错：重开后只写仍被允许的资源可提交", () => {
    const { policy, store, log } = fixture();
    const tx1 = openSession("alice", policy, store, log).beginTransaction();
    tx1.write("doc/A", "a1");
    tx1.write("doc/B", "b1");
    policy.revoke({ subject: "alice", action: "write", resource: "doc/B" });
    assert.equal(tx1.commit().status, "aborted");

    const tx2 = openSession("alice", policy, store, log).beginTransaction();
    tx2.write("doc/A", "a2");
    const r2 = tx2.commit();
    assert.equal(r2.status, "committed");
    assert.deepEqual(store.entries(), { "doc/A": "a2" });
  });

  test("缓冲阶段即被快照拒绝的写直接抛错，不进入重核", () => {
    const { policy, store, log } = fixture();
    const session = openSession("alice", policy, store, log);
    const tx = session.beginTransaction();
    assert.throws(() => tx.write("doc/C", "nope"), AuthorizationError);
    const result = tx.commit();
    assert.equal(result.status, "committed"); // 无缓冲写，空提交成功
    assert.deepEqual(store.entries(), {});
  });
});

describe("命中证据", () => {
  test("记录旧快照命中与新版本重核判定", () => {
    const { policy, store, log } = fixture();
    const session = openSession("alice", policy, store, log);
    const tx = session.beginTransaction();
    tx.read("doc/B");
    tx.write("doc/B", "b1");
    policy.revoke({ subject: "alice", action: "write", resource: "doc/B" });
    tx.read("doc/B"); // 旧快照命中
    tx.commit();

    const stale = log.staleHits();
    assert.ok(stale.length >= 1);
    assert.ok(stale.every((e) => e.checkedVersion < e.latestVersion));

    const rechecks = log.rechecks();
    assert.equal(rechecks.length, 1);
    assert.equal(rechecks[0]?.decision, "deny");
    assert.equal(rechecks[0]?.checkedVersion, policy.latestVersion);
  });
});

describe("边界行为", () => {
  test("按未知版本判定抛 RangeError", () => {
    const { policy } = fixture();
    assert.throws(
      () => policy.allows({ subject: "a", action: "read", resource: "r" }, 999),
      RangeError,
    );
  });

  test("事务关闭后禁止再读写", () => {
    const { policy, store, log } = fixture();
    const tx = openSession("alice", policy, store, log).beginTransaction();
    tx.rollback();
    assert.throws(() => tx.read("doc/A"), /already closed/);
    assert.throws(() => tx.write("doc/A", "x"), /already closed/);
  });
});
