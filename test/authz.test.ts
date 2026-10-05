import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AuthzError,
  DataStore,
  PolicyStore,
  formatEvidence,
} from "../src/authz.js";

const V1_GRANTS = {
  alice: ["doc:read", "doc:write"],
  bob: ["doc:read", "doc:write"],
} as const;

const V2_GRANTS = {
  alice: ["doc:read"], // 撤销 doc:write
  bob: ["doc:read", "doc:write"],
} as const;

describe("会话快照绑定", () => {
  test("会话打开时绑定当前版本，之后发布新版本不影响旧会话的读", () => {
    const policies = new PolicyStore(V1_GRANTS);
    const session = policies.openSession("s1");
    assert.equal(session.boundVersion, 1);

    policies.publish(V2_GRANTS);

    // 旧会话仍按 v1 判定：旧命中
    assert.equal(session.boundVersion, 1);
    assert.equal(session.can("alice", "doc:write"), true);
    // 新会话按 v2 判定：新命中
    const fresh = policies.openSession("s2");
    assert.equal(fresh.boundVersion, 2);
    assert.equal(fresh.can("alice", "doc:write"), false);
  });

  test("长事务期间旧会话可继续读旧权限，新会话读被新策略拦截", () => {
    const policies = new PolicyStore(V1_GRANTS);
    const longSession = policies.openSession("long");
    const txn = longSession.begin();
    txn.stageWrite("alice", "doc:write", "doc:1", "draft");

    policies.publish(V2_GRANTS);

    // 长事务中：旧权限判定仍然放行
    assert.equal(longSession.can("alice", "doc:write"), true);
    // 新会话：暂存同样的写会被 v2 直接拒绝
    const freshTxn = policies.openSession("fresh").begin();
    assert.throws(
      () => freshTxn.stageWrite("alice", "doc:write", "doc:2", "x"),
      (err: unknown) => err instanceof AuthzError && (err as AuthzError).version === 2,
    );
    txn.abort();
  });
});

describe("提交重核", () => {
  test("提交按最新版本重核全部写动作：撤销命中则全不提交", () => {
    const policies = new PolicyStore(V1_GRANTS);
    const data = new DataStore();

    const session = policies.openSession("s-alice");
    const txn = session.begin();
    txn.stageWrite("alice", "doc:write", "doc:1", "a1");
    txn.stageWrite("alice", "doc:write", "doc:2", "a2");

    // 提交前撤销 alice 的写权限
    policies.publish(V2_GRANTS);

    const result = txn.commit(data);

    assert.equal(result.status, "aborted");
    assert.equal(result.sessionVersion, 1);
    assert.equal(result.latestVersion, 2);
    // 全不提交：数据库保持为空
    assert.deepEqual(data.keys(), []);
    assert.equal(data.get("doc:1"), undefined);
    assert.equal(data.get("doc:2"), undefined);
    // 撤销命中证据：旧允许 -> 新拒绝
    assert.equal(result.revocationHits.length, 2);
    for (const hit of result.revocationHits) {
      assert.equal(hit.sessionDecision, "allow");
      assert.equal(hit.latestDecision, "deny");
      assert.equal(hit.outcome, "aborted");
    }
  });

  test("原子性：混合事务中一条被撤销，全部写都不落库", () => {
    const policies = new PolicyStore(V1_GRANTS);
    const data = new DataStore();

    const session = policies.openSession("s-mixed");
    const txn = session.begin();
    txn.stageWrite("alice", "doc:write", "doc:1", "a1"); // 将被 v2 撤销
    txn.stageWrite("bob", "doc:write", "doc:2", "b2"); // v2 下仍允许

    policies.publish(V2_GRANTS);
    const result = txn.commit(data);

    assert.equal(result.status, "aborted");
    // bob 的写在新版本下是允许的，但因同事务 alice 的写被拒，也一并中止
    const bobEvidence = result.evidence.find((e) => e.subject === "bob");
    assert.equal(bobEvidence?.latestDecision, "allow");
    assert.equal(bobEvidence?.outcome, "aborted");
    assert.deepEqual(data.keys(), []);
  });

  test("无撤销时提交成功，全部写落库，证据为 旧允许->新允许", () => {
    const policies = new PolicyStore(V1_GRANTS);
    const data = new DataStore();

    const session = policies.openSession("s-bob");
    const txn = session.begin();
    txn.stageWrite("bob", "doc:write", "doc:9", "b9");

    policies.publish(V2_GRANTS); // bob 权限未变

    const result = txn.commit(data);
    assert.equal(result.status, "committed");
    assert.equal(data.get("doc:9"), "b9");
    assert.deepEqual(result.appliedKeys, ["doc:9"]);
    assert.equal(result.revocationHits.length, 0);
    assert.equal(result.evidence[0]?.sessionDecision, "allow");
    assert.equal(result.evidence[0]?.latestDecision, "allow");
    assert.equal(result.evidence[0]?.outcome, "committed");
  });

  test("重核用的是提交时刻的最新版本，而非会话绑定版本", () => {
    const policies = new PolicyStore(V1_GRANTS);
    const data = new DataStore();

    const session = policies.openSession("s1"); // 绑定 v1
    const txn = session.begin();
    txn.stageWrite("alice", "doc:write", "doc:1", "a1");

    policies.publish(V2_GRANTS); // v2 撤销
    policies.publish(V1_GRANTS); // v3 恢复

    const result = txn.commit(data);
    assert.equal(result.latestVersion, 3);
    assert.equal(result.status, "committed");
    assert.equal(data.get("doc:1"), "a1");
  });
});

describe("证据输出", () => {
  test("formatEvidence 输出旧/新命中明细", () => {
    const policies = new PolicyStore(V1_GRANTS);
    const data = new DataStore();
    const txn = policies.openSession("s").begin();
    txn.stageWrite("alice", "doc:write", "doc:1", "a1");
    policies.publish(V2_GRANTS);
    const text = formatEvidence(txn.commit(data));

    assert.ok(text.includes("旧版本v1=allow -> 新版本v2=deny"));
    assert.ok(text.includes("撤销命中 1 条"));
    assert.ok(text.includes("已中止"));
  });
});
