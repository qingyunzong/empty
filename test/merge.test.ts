import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReplicaStore, type Op } from "../src/store.js";

function opsOf(store: ReplicaStore): Op[] {
  return store.exportOps();
}

describe("乱序合并不复活对象", () => {
  it("先收到 delete 后收到旧 put，对象保持墓碑", () => {
    const source = new ReplicaStore("r1");
    source.put("obj-1", "v1");
    const putOp = opsOf(source)[0]!;
    source.delete("obj-1");
    const deleteOp = opsOf(source)[0]!;
    assert.equal(putOp!.kind, "put");
    assert.equal(deleteOp!.kind, "delete");

    const replica = new ReplicaStore("r2");
    replica.apply(deleteOp); // 乱序：删除先到
    replica.apply(putOp); // 旧 put 迟到

    assert.equal(replica.get("obj-1"), undefined);
    assert.equal(replica.isTombstoned("obj-1"), true);
  });

  it("按序合并结果一致（收敛）", () => {
    const source = new ReplicaStore("r1");
    source.put("obj-1", "v1");
    source.delete("obj-1");
    const ops = opsOf(source);

    const inOrder = new ReplicaStore("r2");
    const reversed = new ReplicaStore("r3");
    inOrder.merge(ops);
    reversed.merge([...ops].reverse());

    assert.equal(inOrder.isTombstoned("obj-1"), true);
    assert.equal(reversed.isTombstoned("obj-1"), true);
    assert.deepEqual(inOrder.tombstoneOf("obj-1"), reversed.tombstoneOf("obj-1"));
  });

  it("删除后更新的 put（版本更高）按 LWW 合法生效", () => {
    const source = new ReplicaStore("r1");
    source.put("obj-1", "v1");
    source.delete("obj-1");
    const revived = source.put("obj-1", "v2");

    const replica = new ReplicaStore("r2");
    replica.merge(opsOf(source));
    assert.equal(replica.get("obj-1")?.value, "v2");
    assert.equal(replica.isTombstoned("obj-1"), false);
    assert.deepEqual(replica.get("obj-1")?.version, revived.version);
  });

  it("并发写按 (time, origin) 全序决定胜负，各副本收敛", () => {
    const a = new ReplicaStore("rA");
    const b = new ReplicaStore("rB");
    a.put("obj-1", "from-A");
    b.put("obj-1", "from-B");

    const opsA = opsOf(a);
    const opsB = opsOf(b);
    a.merge(opsB);
    b.merge(opsA);

    assert.equal(a.get("obj-1")?.value, b.get("obj-1")?.value);
  });
});
