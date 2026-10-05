import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactEntry,
  applyPlan,
  invertPlan,
  mergeManifests,
} from "../src/merge";

/** 构造一条制品记录。 */
function e(id: string, path: string, digest: string): ArtifactEntry {
  return { id, path, digest };
}

const sortById = (list: ArtifactEntry[]) =>
  [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// ---------- 摘要规则（逐 ID 独立核对） ----------

test("无变化：原样合并，计划为空，无冲突", () => {
  const base = [e("a", "lib/a.txt", "d1")];
  const r = mergeManifests({ base, ours: base, theirs: base });
  assert.deepEqual(r.merged, base);
  assert.deepEqual(r.plan, []);
  assert.deepEqual(r.conflicts, []);
});

test("仅 ours 改摘要：采用 ours", () => {
  const r = mergeManifests({
    base: [e("a", "lib/a.txt", "d1")],
    ours: [e("a", "lib/a.txt", "d2")],
    theirs: [e("a", "lib/a.txt", "d1")],
  });
  assert.deepEqual(r.merged, [e("a", "lib/a.txt", "d2")]);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.plan, [
    { op: "update", id: "a", before: e("a", "lib/a.txt", "d1"), after: e("a", "lib/a.txt", "d2") },
  ]);
});

test("仅 theirs 改摘要：采用 theirs", () => {
  const r = mergeManifests({
    base: [e("a", "lib/a.txt", "d1")],
    ours: [e("a", "lib/a.txt", "d1")],
    theirs: [e("a", "lib/a.txt", "d3")],
  });
  assert.deepEqual(r.merged, [e("a", "lib/a.txt", "d3")]);
  assert.deepEqual(r.conflicts, []);
});

test("双侧改成相同摘要：直接合并，不算冲突", () => {
  const r = mergeManifests({
    base: [e("a", "lib/a.txt", "d1")],
    ours: [e("a", "lib/a.txt", "d9")],
    theirs: [e("a", "lib/a.txt", "d9")],
  });
  assert.deepEqual(r.merged, [e("a", "lib/a.txt", "d9")]);
  assert.deepEqual(r.conflicts, []);
});

test("双侧改成不同摘要：digest-conflict，不进入结果与计划", () => {
  const r = mergeManifests({
    base: [e("a", "lib/a.txt", "d1")],
    ours: [e("a", "lib/a.txt", "d2")],
    theirs: [e("a", "lib/a.txt", "d3")],
  });
  assert.deepEqual(r.merged, []);
  assert.deepEqual(r.plan, []);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].type, "digest-conflict");
  assert.equal(r.conflicts[0].id, "a");
  assert.equal(r.conflicts[0].ours?.digest, "d2");
  assert.equal(r.conflicts[0].theirs?.digest, "d3");
});

// ---------- 移动规则（按对象 ID 识别） ----------

test("路径移动按对象 ID 识别：仅 ours 移动则采用新路径", () => {
  const r = mergeManifests({
    base: [e("a", "old/a.txt", "d1")],
    ours: [e("a", "new/a.txt", "d1")],
    theirs: [e("a", "old/a.txt", "d1")],
  });
  assert.deepEqual(r.merged, [e("a", "new/a.txt", "d1")]);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.plan, [
    { op: "update", id: "a", before: e("a", "old/a.txt", "d1"), after: e("a", "new/a.txt", "d1") },
  ]);
});

test("双侧移到同一路径：合并成功", () => {
  const r = mergeManifests({
    base: [e("a", "old/a.txt", "d1")],
    ours: [e("a", "new/a.txt", "d1")],
    theirs: [e("a", "new/a.txt", "d1")],
  });
  assert.deepEqual(r.merged, [e("a", "new/a.txt", "d1")]);
  assert.deepEqual(r.conflicts, []);
});

test("双侧移到不同路径：move-conflict", () => {
  const r = mergeManifests({
    base: [e("a", "old/a.txt", "d1")],
    ours: [e("a", "x/a.txt", "d1")],
    theirs: [e("a", "y/a.txt", "d1")],
  });
  assert.deepEqual(r.merged, []);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].type, "move-conflict");
});

test("移动撞名不自动覆盖：ours 把 a 移到 b 已占用的路径", () => {
  const r = mergeManifests({
    base: [e("a", "old/a.txt", "d1"), e("b", "lib/b.txt", "d2")],
    ours: [e("a", "lib/b.txt", "d1"), e("b", "lib/b.txt", "d2")],
    theirs: [e("a", "old/a.txt", "d1"), e("b", "lib/b.txt", "d2")],
  });
  // 两个对象都被记为 path-collision，均不进入合并结果，b 不被覆盖。
  assert.deepEqual(r.merged, []);
  assert.deepEqual(r.plan, []);
  assert.equal(r.conflicts.length, 2);
  assert.ok(r.conflicts.every((c) => c.type === "path-collision"));
  const forA = r.conflicts.find((c) => c.id === "a")!;
  const forB = r.conflicts.find((c) => c.id === "b")!;
  assert.equal(forA.path, "lib/b.txt");
  assert.deepEqual(forA.collidesWith, ["b"]);
  assert.deepEqual(forB.collidesWith, ["a"]);
});

test("一侧移动与另一侧改摘要可叠加：同 ID 不同字段各自合并", () => {
  const r = mergeManifests({
    base: [e("a", "old/a.txt", "d1")],
    ours: [e("a", "new/a.txt", "d1")],
    theirs: [e("a", "old/a.txt", "d2")],
  });
  assert.deepEqual(r.merged, [e("a", "new/a.txt", "d2")]);
  assert.deepEqual(r.conflicts, []);
});

// ---------- 新增 / 删除规则 ----------

test("仅一侧新增：采用新增", () => {
  const r = mergeManifests({
    base: [],
    ours: [e("n", "lib/n.txt", "d1")],
    theirs: [],
  });
  assert.deepEqual(r.merged, [e("n", "lib/n.txt", "d1")]);
  assert.deepEqual(r.plan, [{ op: "add", entry: e("n", "lib/n.txt", "d1") }]);
});

test("双侧新增且完全一致：合并成功", () => {
  const r = mergeManifests({
    base: [],
    ours: [e("n", "lib/n.txt", "d1")],
    theirs: [e("n", "lib/n.txt", "d1")],
  });
  assert.deepEqual(r.merged, [e("n", "lib/n.txt", "d1")]);
  assert.deepEqual(r.conflicts, []);
});

test("双侧新增同一 id 但内容不同：add-add 冲突", () => {
  const r = mergeManifests({
    base: [],
    ours: [e("n", "lib/n.txt", "d1")],
    theirs: [e("n", "lib/n.txt", "d2")],
  });
  assert.deepEqual(r.merged, []);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].type, "add-add");
});

test("一侧删除且另一侧未改：接受删除", () => {
  const r = mergeManifests({
    base: [e("a", "lib/a.txt", "d1")],
    ours: [],
    theirs: [e("a", "lib/a.txt", "d1")],
  });
  assert.deepEqual(r.merged, []);
  assert.deepEqual(r.plan, [{ op: "remove", entry: e("a", "lib/a.txt", "d1") }]);
  assert.deepEqual(r.conflicts, []);
});

test("一侧删除但另一侧修改：delete-modify 冲突", () => {
  const r = mergeManifests({
    base: [e("a", "lib/a.txt", "d1")],
    ours: [],
    theirs: [e("a", "lib/a.txt", "d2")],
  });
  assert.deepEqual(r.merged, []);
  assert.deepEqual(r.plan, []);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].type, "delete-modify");
  assert.equal(r.conflicts[0].theirs?.digest, "d2");
});

test("双侧都删除：接受删除", () => {
  const r = mergeManifests({
    base: [e("a", "lib/a.txt", "d1")],
    ours: [],
    theirs: [],
  });
  assert.deepEqual(r.merged, []);
  assert.deepEqual(r.plan, [{ op: "remove", entry: e("a", "lib/a.txt", "d1") }]);
});

// ---------- 可逆计划 ----------

test("计划可逆：applyPlan(base, plan) === merged，逆计划可还原 base", () => {
  const base = [
    e("a1", "lib/a1.txt", "d1"), // ours 改摘要
    e("a2", "old/a2.txt", "d2"), // theirs 移动
    e("a3", "lib/a3.txt", "d3"), // ours 删除
    e("a4", "lib/a4.txt", "d4"), // 不变
  ];
  const ours = [
    e("a1", "lib/a1.txt", "d1x"),
    e("a2", "old/a2.txt", "d2"),
    e("a4", "lib/a4.txt", "d4"),
  ];
  const theirs = [
    e("a1", "lib/a1.txt", "d1"),
    e("a2", "new/a2.txt", "d2"),
    e("a3", "lib/a3.txt", "d3"),
    e("a4", "lib/a4.txt", "d4"),
    e("a5", "lib/a5.txt", "d5"), // theirs 新增
  ];
  const r = mergeManifests({ base, ours, theirs });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(applyPlan(base, r.plan), r.merged);
  assert.deepEqual(applyPlan(r.merged, invertPlan(r.plan)), sortById(base));
});

test("含冲突时计划仍只覆盖无冲突部分且可逆", () => {
  const base = [e("ok", "lib/ok.txt", "d1"), e("bad", "lib/bad.txt", "d1")];
  const ours = [e("ok", "lib/ok.txt", "d2"), e("bad", "lib/bad.txt", "dx")];
  const theirs = [e("ok", "lib/ok.txt", "d1"), e("bad", "lib/bad.txt", "dy")];
  const r = mergeManifests({ base, ours, theirs });
  assert.deepEqual(r.merged, [e("ok", "lib/ok.txt", "d2")]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].type, "digest-conflict");
  // 计划只覆盖无冲突部分：应用到 base 后，冲突对象仍保持 base 原状。
  const applied = applyPlan(base, r.plan);
  assert.deepEqual(applied, [e("bad", "lib/bad.txt", "d1"), e("ok", "lib/ok.txt", "d2")]);
  // 逆计划完整还原 base。
  assert.deepEqual(applyPlan(applied, invertPlan(r.plan)), sortById(base));
});

// ---------- 输入校验 ----------

test("同一清单内 id 重复：抛错", () => {
  assert.throws(
    () =>
      mergeManifests({
        base: [e("a", "p1", "d1"), e("a", "p2", "d2")],
        ours: [],
        theirs: [],
      }),
    /duplicate object id/,
  );
});
