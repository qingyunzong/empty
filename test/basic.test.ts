import { test } from "node:test";
import assert from "node:assert/strict";
import { ORSet, parseTag } from "../src/index.js";

test("每次添加生成全局唯一 tag", () => {
  const set = new ORSet<string>("A");
  const m1 = set.add("x");
  const m2 = set.add("x");
  assert.notEqual(m1.tag, m2.tag);
  assert.deepEqual(parseTag(m1.tag), { origin: "A", seq: 1 });
  assert.deepEqual(parseTag(m2.tag), { origin: "A", seq: 2 });
  assert.equal(set.entryCount, 2);
  assert.equal(set.size, 1, "同一值去重后只有一个元素");
});

test("删除只移除当时观察到的 tag", () => {
  const a = new ORSet<string>("A");
  const b = new ORSet<string>("B");

  const add1 = a.add("x");
  b.apply(add1); // B 只观察到第一个添加

  const add2 = a.add("x"); // A 并发地再次添加，B 尚未看到
  const remove = b.remove("x");
  assert.ok(remove);
  assert.deepEqual(remove.tags, [add1.tag], "删除消息只包含观察到的 tag");

  a.apply(remove); // 旧删除到达 A
  assert.ok(a.has("x"), "未见的并发添加不能被旧删除吞掉（add-wins）");
  a.apply(add2); // 重复应用自己的消息，幂等
  assert.equal(a.entryCount, 1);
});

test("删除不存在的值返回 null 且不产生状态", () => {
  const set = new ORSet<string>("A");
  assert.equal(set.remove("ghost"), null);
  assert.equal(set.tombstoneCount, 0);
  assert.equal(set.size, 0);
});

test("删除后值消失，墓碑保留以吞掉晚到的添加", () => {
  const a = new ORSet<string>("A");
  const add = a.add("x");
  a.remove("x");
  assert.ok(!a.has("x"));
  assert.equal(a.tombstoneCount, 1);
  a.apply(add); // 重放旧添加
  assert.ok(!a.has("x"), "墓碑必须吞掉重放的添加");
});

test("merge 为并集且幂等", () => {
  const a = new ORSet<string>("A");
  const b = new ORSet<string>("B");
  a.add("apple");
  a.add("shared");
  b.add("banana");
  b.add("shared");

  a.merge(b);
  b.merge(a);
  assert.deepEqual([...a.values()].sort(), ["apple", "banana", "shared"]);
  assert.ok(a.equals(b));

  // 数据层面幂等：重复合并后条目、墓碑、时钟不变
  a.merge(b);
  b.merge(a);
  a.merge(b);
  assert.equal(a.entryCount, 4);
  assert.equal(a.tombstoneCount, 0);
  assert.deepEqual(a.clockData(), { A: 2, B: 2 });
  assert.ok(a.equals(b));
});

test("merge 中墓碑优先：一侧删除并集后仍删除", () => {
  const a = new ORSet<string>("A");
  const b = new ORSet<string>("B");
  const add = a.add("x");
  b.apply(add);
  b.remove("x"); // B 删除，A 未删除

  a.merge(b);
  b.merge(a);
  assert.ok(!a.has("x"));
  assert.ok(!b.has("x"));
  assert.ok(a.equals(b));
});

test("快照恢复后状态一致", () => {
  const a = new ORSet<string>("A");
  const m1 = a.add("x");
  a.add("y");
  a.remove("x");
  const restored = ORSet.restore<string>(a.snapshot());
  assert.ok(a.equals(restored));
  assert.ok(!restored.has("x"));
  assert.ok(restored.has("y"));
  // 恢复后继续添加，tag 不与历史冲突
  const m2 = restored.add("z");
  assert.notEqual(m2.tag, m1.tag);
  assert.deepEqual(parseTag(m2.tag), { origin: "A", seq: 3 });
});
