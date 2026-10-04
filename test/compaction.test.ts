import { test } from "node:test";
import assert from "node:assert/strict";
import { ORSet } from "../src/index.js";
import { syncAcks, syncMerge } from "./helpers.js";

const MEMBERS = ["A", "B", "C"];

/** 搭好 A/B/C 三副本：登记成员 → A 添加 x 并全量同步 → B 删除 x 并全量同步。 */
function setupRemoved() {
  const a = new ORSet<string>("A");
  const b = new ORSet<string>("B");
  const c = new ORSet<string>("C");
  for (const r of [a, b, c]) {
    for (const id of MEMBERS) r.trackReplica(id); // 显式成员关系：全部副本都需参与确认
  }
  const add = a.add("x");
  b.apply(add);
  c.apply(add);
  const remove = b.remove("x");
  if (!remove) throw new Error("remove should exist");
  a.apply(remove);
  c.apply(remove);
  return { a, b, c, add, remove };
}

test("确认向量未收齐时压缩不回收任何墓碑", () => {
  const { a, b, add } = setupRemoved();
  // A 只收到过 B 的消息，C 的确认向量未到 → 不得压缩
  assert.equal(a.tombstoneCount, 1);
  assert.deepEqual(a.compact(), []);
  assert.equal(a.tombstoneCount, 1);

  // 只有部分副本确认也不够
  a.apply(b.ack());
  assert.deepEqual(a.compact(), []);
  assert.equal(a.tombstoneCount, 1);

  // C 的确认必须覆盖 add 事件：空时钟确认不够
  a.apply(add); // 重复投递，幂等
  a.apply(new ORSet<string>("C").ack());
  assert.deepEqual(a.compact(), []);

  // C 真正观察到 add 后的确认到达 → 可以压缩
  const { c } = setupRemoved();
  a.apply(c.ack());
  assert.deepEqual(a.compact(), [add.tag]);
  assert.equal(a.tombstoneCount, 0);
});

test("全部副本确认后压缩回收墓碑，且重放旧添加不会复活", () => {
  const { a, b, c, add, remove } = setupRemoved();
  syncAcks([a, b, c]); // 全副本互发确认向量

  const collected = a.compact();
  assert.deepEqual(collected, [add.tag]);
  assert.equal(a.tombstoneCount, 0);
  assert.ok(!a.has("x"));

  // 压缩后重放旧添加/旧删除：值状态不变（旧添加被时钟判重吞掉）
  a.apply(add);
  a.apply(remove);
  assert.ok(!a.has("x"));
  assert.equal(a.entryCount, 0);

  // 压缩后再与未压缩副本合并，状态收敛且不复活；再次压缩后墓碑清零
  b.compact();
  c.compact();
  syncMerge([a, b, c]);
  for (const r of [a, b, c]) {
    assert.ok(!r.has("x"));
    r.compact();
    assert.equal(r.tombstoneCount, 0);
  }
  assert.ok(a.equals(b) && b.equals(c));
});

test("登记的离线副本会阻止压缩，直到其确认到达", () => {
  const { a, b, c, add } = setupRemoved();
  a.trackReplica("D"); // D 是已知成员但离线
  syncAcks([a, b, c]);
  assert.deepEqual(a.compact(), [], "D 未确认前不得回收");

  // D 上线：从 B 同步状态后广播确认
  const d = new ORSet<string>("D");
  d.merge(b);
  a.apply(d.ack());
  assert.deepEqual(a.compact(), [add.tag]);
});

test("新副本通过合并加入后与其他副本收敛", () => {
  const { a, b, c } = setupRemoved();
  syncAcks([a, b, c]);
  const d = new ORSet<string>("D");
  d.merge(a);
  d.add("new");
  syncMerge([a, b, c, d]);
  for (const r of [b, c, d]) {
    assert.ok(a.equals(r));
  }
  assert.ok(d.has("new"));
  assert.ok(!d.has("x"));
});
