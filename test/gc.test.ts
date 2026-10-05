import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Cluster } from "../src/cluster.js";
import { ReplicaStore } from "../src/store.js";

function makeCluster(replicaIds: string[]): Cluster {
  const cluster = new Cluster((id) => new ReplicaStore(id));
  for (const id of replicaIds) cluster.addReplica(id);
  return cluster;
}

describe("垃圾回收：全副本确认 + 无历史根引用", () => {
  it("部分副本未确认时墓碑保留", () => {
    const cluster = makeCluster(["r1", "r2"]);
    const r1 = cluster.replica("r1");
    r1.put("obj-1", "v");
    r1.delete("obj-1");
    // r2 尚未同步，未确认墓碑

    const report = cluster.collectGarbage();
    assert.equal(report.collected.length, 0);
    const retained = report.retained.find((t) => t.objectId === "obj-1");
    assert.ok(retained);
    assert.ok(retained.reasons.some((r) => r.startsWith("unconfirmed-replicas:r2")));
    assert.equal(r1.isTombstoned("obj-1"), true);
  });

  it("全副本确认且无引用时回收墓碑", () => {
    const cluster = makeCluster(["r1", "r2", "r3"]);
    cluster.replica("r1").put("obj-1", "v");
    cluster.replica("r1").delete("obj-1");
    cluster.syncAll();

    const report = cluster.collectGarbage();
    assert.equal(report.collected.length, 3);
    for (const id of ["r1", "r2", "r3"]) {
      assert.equal(cluster.replica(id).isTombstoned("obj-1"), false);
    }
  });

  it("历史快照引用墓碑对象时保留，释放快照后回收", () => {
    const cluster = makeCluster(["r1", "r2"]);
    const r1 = cluster.replica("r1");
    r1.put("obj-1", "v");
    const doc = cluster.createDocument("doc-1", "r1");
    doc.attach("obj-1");
    doc.snapshot("snap-1");
    doc.detach("obj-1");

    r1.delete("obj-1");
    cluster.syncAll();

    const first = cluster.collectGarbage();
    assert.equal(first.collected.length, 0);
    const retained = first.retained.find((t) => t.objectId === "obj-1");
    assert.ok(retained);
    assert.ok(retained.reasons.some((r) => r === "historical-root:doc-1#snap-1"));

    doc.releaseSnapshot("snap-1");
    const second = cluster.collectGarbage();
    assert.equal(second.collected.length, 2);
    assert.equal(r1.isTombstoned("obj-1"), false);
  });

  it("活文档仍引用（删除发生在引用后）时不删可达墓碑并报告阻塞", () => {
    const cluster = makeCluster(["r1", "r2"]);
    const r1 = cluster.replica("r1");
    r1.put("obj-1", "v");
    const doc = cluster.createDocument("doc-1", "r1");
    doc.attach("obj-1");

    r1.delete("obj-1"); // 引用之后才被删除
    cluster.syncAll();

    assert.deepEqual(cluster.blockedReferences(), [
      { documentId: "doc-1", objectId: "obj-1" },
    ]);

    const report = cluster.collectGarbage();
    assert.equal(report.collected.length, 0);
    const retained = report.retained.find((t) => t.objectId === "obj-1");
    assert.ok(retained);
    assert.ok(retained.reasons.some((r) => r === "live-document:doc-1"));

    doc.detach("obj-1");
    const second = cluster.collectGarbage();
    assert.equal(second.collected.length, 2);
  });

  it("多个快照时仅释放其一，仍可达的墓碑不被删除", () => {
    const cluster = makeCluster(["r1"]);
    const r1 = cluster.replica("r1");
    r1.put("obj-1", "v");
    const doc = cluster.createDocument("doc-1", "r1");
    doc.attach("obj-1");
    doc.snapshot("snap-1");
    doc.snapshot("snap-2");
    doc.detach("obj-1");
    r1.delete("obj-1");

    doc.releaseSnapshot("snap-1");
    const report = cluster.collectGarbage();
    assert.equal(report.collected.length, 0);
    assert.equal(r1.isTombstoned("obj-1"), true);

    doc.releaseSnapshot("snap-2");
    const second = cluster.collectGarbage();
    assert.equal(second.collected.length, 1);
  });

  it("GC 后迟到的旧 put 无法复活已回收对象", () => {
    const cluster = makeCluster(["r1", "r2"]);
    const r1 = cluster.replica("r1");
    r1.put("obj-1", "v1");
    const stalePut = r1.exportOps().find((op) => op.kind === "put")!;
    r1.delete("obj-1");
    cluster.syncAll();

    const report = cluster.collectGarbage();
    assert.equal(report.collected.length, 2);

    // 模拟乱序迟到的旧 put 在 GC 之后才到达
    cluster.replica("r2").apply(stalePut);
    assert.equal(cluster.replica("r2").get("obj-1"), undefined);
    assert.equal(cluster.replica("r2").isTombstoned("obj-1"), false);
  });
});
