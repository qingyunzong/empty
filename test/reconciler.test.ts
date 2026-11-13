import assert from "node:assert/strict";
import { test } from "node:test";
import { Reconciler } from "../src/reconciler.ts";

test("版本化桶：重复与乱序事件按 version id 裁决", () => {
  const r = new Reconciler({ versioned: true });
  // 乱序 + 重复投递
  r.ingestEvent({ type: "create", key: "a", versionId: "v2", eventTime: 200 });
  r.ingestEvent({ type: "delete", key: "a", versionId: "v1", eventTime: 150 });
  r.ingestEvent({ type: "create", key: "a", versionId: "v1", eventTime: 100 });
  r.ingestEvent({ type: "create", key: "a", versionId: "v1", eventTime: 100 }); // 重复
  r.ingestEvent({ type: "create", key: "a", versionId: "v1", eventTime: 100 }); // 重复

  // v1 已删、v2 存在；清单只含 v2 → 无差异
  const report1 = r.ingestList([{ key: "a", versionId: "v2" }]);
  assert.deepEqual(report1.pending, []);
  assert.equal(report1.converged, false); // 首轮不收敛
  const report2 = r.ingestList([{ key: "a", versionId: "v2" }]);
  assert.equal(report2.converged, true);
  assert.deepEqual(report2.missing, []);
  assert.deepEqual(report2.ghost, []);
});

test("版本化桶：delete 只作用于相同 versionId", () => {
  const r = new Reconciler({ versioned: true });
  r.ingestEvent({ type: "create", key: "a", versionId: "v1" });
  r.ingestEvent({ type: "create", key: "a", versionId: "v2" });
  r.ingestEvent({ type: "delete", key: "a", versionId: "v1" });

  r.ingestList([{ key: "a", versionId: "v2" }]);
  const report = r.ingestList([{ key: "a", versionId: "v2" }]);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.ghost, []);
});

test("无版本桶：迟到删除不误伤重建对象", () => {
  const r = new Reconciler();
  r.ingestEvent({ type: "create", key: "k", eventTime: 1 });
  r.ingestEvent({ type: "delete", key: "k", eventTime: 2 });
  r.ingestEvent({ type: "create", key: "k", eventTime: 3 }); // 重建，新世代
  // 针对旧世代的迟到删除（乱序到达）
  assert.equal(r.ingestEvent({ type: "delete", key: "k", eventTime: 2 }), false);

  r.ingestList([{ key: "k" }]);
  const report = r.ingestList([{ key: "k" }]);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.ghost, []);
});

test("无版本桶：清单观测推进观测世代，愈合迟到删除", () => {
  const r = new Reconciler();
  r.ingestEvent({ type: "create", key: "k", eventTime: 1 });
  r.ingestEvent({ type: "delete", key: "k", eventTime: 2 });
  // 重建的 create 事件丢失，但清单观测到对象仍在 → 观测世代推进
  const report = r.ingestList([{ key: "k" }], 3);
  assert.deepEqual(report.pending, []);
  assert.deepEqual(report.ghost, []);
});

test("无版本桶：早于删除事件的旧清单快照不触发生世推进", () => {
  const r = new Reconciler();
  r.ingestEvent({ type: "create", key: "k", eventTime: 10 });
  r.ingestEvent({ type: "delete", key: "k", eventTime: 20 });
  // 清单快照时间(15)早于删除事件(20) → 不愈合，报 ghost
  const report = r.ingestList([{ key: "k" }], 15);
  assert.deepEqual(report.pending, [
    { kind: "ghost", key: "k", versionId: undefined },
  ]);
});

test("缺失与幽灵：首轮 pending，次轮晋升，连续两轮一致后收敛", () => {
  const r = new Reconciler();
  r.ingestEvent({ type: "create", key: "expected" });

  const round1 = r.ingestList([{ key: "unexpected" }]);
  assert.equal(round1.round, 1);
  assert.deepEqual(round1.missing, []);
  assert.deepEqual(round1.ghost, []);
  assert.deepEqual(round1.pending, [
    { kind: "missing", key: "expected", versionId: undefined },
    { kind: "ghost", key: "unexpected", versionId: undefined },
  ]);
  assert.equal(round1.converged, false);

  const round2 = r.ingestList([{ key: "unexpected" }]);
  assert.deepEqual(round2.missing, [
    { kind: "missing", key: "expected", versionId: undefined },
  ]);
  assert.deepEqual(round2.ghost, [
    { kind: "ghost", key: "unexpected", versionId: undefined },
  ]);
  assert.deepEqual(round2.pending, []);
  assert.equal(round2.converged, true);
});

test("差异消失后需要重新连续两轮一致才收敛", () => {
  const r = new Reconciler();
  r.ingestEvent({ type: "create", key: "k" });

  r.ingestList([]); // pending: missing k
  const stable = r.ingestList([]);
  assert.equal(stable.converged, true);
  assert.equal(stable.missing.length, 1);

  const healed = r.ingestList([{ key: "k" }]); // 差异消失
  assert.equal(healed.converged, false);
  assert.deepEqual(healed.missing, []);
  const converged = r.ingestList([{ key: "k" }]);
  assert.equal(converged.converged, true);
});

test("无版本桶：已删除后重复的 delete 事件被忽略", () => {
  const r = new Reconciler();
  r.ingestEvent({ type: "create", key: "k", eventTime: 1 });
  r.ingestEvent({ type: "delete", key: "k", eventTime: 2 });
  // 不同指纹但语义上针对旧世代的迟到删除：对象已不存在，忽略
  assert.equal(r.ingestEvent({ type: "delete", key: "k", eventTime: 3 }), false);
  r.ingestEvent({ type: "create", key: "k", eventTime: 4 }); // 重建
  r.ingestList([{ key: "k" }]);
  const report = r.ingestList([{ key: "k" }]);
  assert.deepEqual(report.missing, []);
});
