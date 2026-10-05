import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { Replica } from "../src/store.js";
import { SyncNetwork } from "../src/sync.js";

test("GC 需全副本确认：任一副本未确认则墓碑保留", () => {
  const a = new Replica("A");
  const b = new Replica("B");
  const c = new Replica("C");
  const net = new SyncNetwork();
  net.connect(a, b, c);

  a.put("obj1", "v1");
  a.remove("obj1");
  net.sync();
  // C 离线后 A 又删了 obj2
  const del2 = a.remove("obj2");
  b.apply(del2);
  a.acknowledge("B", b.vector); // 只有 B 确认，C 未确认

  deepEqual(a.collectGarbage(), ["obj1"], "obj1 全副本确认可回收");
  ok(a.records.has("obj2"), "obj2 未获 C 确认，墓碑必须保留");

  net.sync(); // C 追上并确认
  deepEqual(a.collectGarbage(), ["obj2"]);
});

test("GC 需无历史根引用：快照引用阻止回收，释放后才可回收", () => {
  const a = new Replica("A");
  const b = new Replica("B");
  const net = new SyncNetwork();
  net.connect(a, b);

  a.put("obj1", "v1");
  a.attachDocument("doc1", ["obj1"]);
  a.takeSnapshot("snap1"); // 历史根固定 obj1
  a.detachDocument("doc1");
  a.remove("obj1");
  net.sync(); // 全副本已确认删除

  deepEqual(a.collectGarbage(), [], "快照仍引用，墓碑不得回收");
  ok(a.records.get("obj1")!.deleted);

  a.releaseSnapshot("snap1");
  deepEqual(a.collectGarbage(), ["obj1"], "快照释放后墓碑可回收");
  equal(a.records.has("obj1"), false);
});

test("快照释放验收：不复活对象、不删仍可达墓碑", () => {
  const a = new Replica("A");
  const b = new Replica("B");
  const net = new SyncNetwork();
  net.connect(a, b);

  a.put("keep", "k");
  a.put("drop", "d");
  a.attachDocument("doc-live", ["keep"]); // keep 仍被活文档引用
  a.attachDocument("doc-temp", ["drop"]); // drop 仅被临时文档引用
  a.takeSnapshot("snap1"); // 快照同时固定 keep 与 drop
  a.detachDocument("doc-temp"); // 快照成为 drop 的唯一历史根
  a.remove("keep");
  a.remove("drop");
  net.sync();

  deepEqual(a.collectGarbage(), [], "快照未释放，两个墓碑都保留");
  a.releaseSnapshot("snap1");
  deepEqual(a.collectGarbage(), ["drop"], "仅回收不再可达的 drop");

  const keep = a.records.get("keep");
  ok(keep, "仍被活文档引用的墓碑不得删除");
  equal(keep!.deleted, true, "对象保持删除状态，不得复活");
  equal(a.records.has("drop"), false);
  deepEqual(a.blockedReferences(), [
    { document: "doc-live", object: "keep", reason: "tombstone" },
  ]);
});

test("GC 后重投旧操作不复活对象（去重保护）", () => {
  const a = new Replica("A");
  const b = new Replica("B");
  const net = new SyncNetwork();
  net.connect(a, b);

  const put = a.put("obj1", "v1");
  a.remove("obj1");
  net.sync();
  deepEqual(a.collectGarbage(), ["obj1"]);

  a.apply(put); // 延迟重投的旧 put
  equal(a.records.has("obj1"), false, "已回收对象不得因旧操作复活");
});
