import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { Replica } from "../src/store.js";

test("删除对象留下墓碑，数据清空但记录保留", () => {
  const r = new Replica("A");
  r.put("obj1", "hello");
  r.remove("obj1");
  const record = r.records.get("obj1");
  ok(record, "墓碑记录必须存在");
  equal(record!.deleted, true);
  equal(record!.data, null);
});

test("删除本地未知对象也写墓碑，迟到的旧 put 不复活对象", () => {
  const a = new Replica("A");
  const b = new Replica("B");
  const put = a.put("obj1", "v1");
  const del = a.remove("obj1");
  // 乱序：B 先收到删除（对象未知），后收到旧 put
  b.apply(del);
  b.apply(put);
  const record = b.records.get("obj1");
  ok(record);
  equal(record!.deleted, true, "旧 put 不得复活已删除对象");
});

test("活文档引用墓碑对象报阻塞，重新 put 后解除", () => {
  const r = new Replica("A");
  r.put("obj1", "a");
  r.put("obj2", "b");
  r.attachDocument("doc1", ["obj1", "obj2"]);
  equal(r.blockedReferences().length, 0);
  r.remove("obj1");
  deepEqual(r.blockedReferences(), [
    { document: "doc1", object: "obj1", reason: "tombstone" },
  ]);
  r.put("obj1", "a2"); // 更新的写入覆盖墓碑
  equal(r.blockedReferences().length, 0);
});

test("引用缺失对象同样报阻塞（reason=missing）", () => {
  const r = new Replica("A");
  r.attachDocument("doc1", ["ghost"]);
  deepEqual(r.blockedReferences(), [
    { document: "doc1", object: "ghost", reason: "missing" },
  ]);
});

test("合并乱序且幂等：重复投递不改变状态", () => {
  const a = new Replica("A");
  const b = new Replica("B");
  const ops = [a.put("x", "1"), a.put("x", "2"), a.remove("x")];
  b.apply(ops[2]!);
  b.apply(ops[0]!);
  b.apply(ops[1]!);
  b.apply(ops[1]!); // 重复
  b.apply(ops[2]!); // 重复
  const record = b.records.get("x");
  ok(record);
  equal(record!.deleted, true);
  equal(b.vector.get("A"), 3);
});
