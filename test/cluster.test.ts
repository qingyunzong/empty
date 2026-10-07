import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { Cluster } from "../src/cluster";
import { sortedIds } from "../src/versionedValue";

test("分区下并发写, 愈合后冲突集合保留两个版本", () => {
  const cluster = new Cluster(["R0", "R1", "R2"]);
  cluster.write("WIDGET", 10, 0, 3);
  cluster.partition([[0], [1, 2]]);
  cluster.write("WIDGET", 99, 0, 1);
  cluster.write("WIDGET", 20, 1, 2);
  cluster.heal();
  cluster.syncAll();
  for (const replica of cluster.replicas) {
    equal(replica.getSet("WIDGET").length, 2);
  }
  const result = cluster.read("WIDGET", [0, 1]);
  deepEqual(result.state, { kind: "conflict", values: [20, 99] });
});

test("因果写覆盖旧版本, 冲突集合收敛为单版本", () => {
  const cluster = new Cluster(["R0", "R1"]);
  cluster.write("SKU", 1, 0, 2);
  cluster.write("SKU", 2, 1, 2);
  cluster.syncAll();
  for (const replica of cluster.replicas) {
    equal(replica.getSet("SKU").length, 1);
  }
  const result = cluster.read("SKU", [0, 1]);
  deepEqual(result.state, { kind: "value", value: 2 });
});

test("读路径强制至少两个副本", () => {
  const cluster = new Cluster(["R0", "R1"]);
  cluster.write("SKU", 1, 0, 2);
  throws(() => cluster.read("SKU", [0]));
});

test("读修复: 缺版本副本在读后被补齐并留下证据", () => {
  const cluster = new Cluster(["R0", "R1", "R2"]);
  cluster.write("SKU-B", 5, 0, 1);
  equal(cluster.replicas[1].getSet("SKU-B").length, 0);
  const result = cluster.read("SKU-B", [0, 1]);
  deepEqual(result.state, { kind: "value", value: 5 });
  equal(result.repairs.length, 1);
  equal(result.repairs[0].replica, "R1");
  equal(result.repairs[0].added.length, 1);
  equal(cluster.replicas[1].getSet("SKU-B").length, 1);
  deepEqual(
    sortedIds(cluster.replicas[0].getSet("SKU-B")),
    sortedIds(cluster.replicas[1].getSet("SKU-B")),
  );
});

test("撤回后愈合: 墓碑支配旧版本, 旧值不复活", () => {
  const cluster = new Cluster(["R0", "R1", "R2"]);
  cluster.write("SKU-D", 7, 0, 3);
  cluster.partition([[0, 1], [2]]);
  cluster.delete("SKU-D", 0, 2);
  cluster.heal();
  cluster.syncAll();
  for (const replica of cluster.replicas) {
    const set = replica.getSet("SKU-D");
    equal(set.length, 1);
    equal(set[0].tombstone, true);
  }
  const result = cluster.read("SKU-D", [0, 2]);
  deepEqual(result.state, { kind: "deleted" });
});

test("撤回与并发写并存: 新写存活, 被撤回的旧版本不复活", () => {
  const cluster = new Cluster(["R0", "R1", "R2"]);
  cluster.write("SKU-E", 1, 0, 3);
  cluster.partition([[0], [1, 2]]);
  cluster.delete("SKU-E", 0, 1);
  cluster.write("SKU-E", 2, 1, 2);
  cluster.heal();
  cluster.syncAll();
  const result = cluster.read("SKU-E", [0, 1, 2]);
  deepEqual(result.state, { kind: "value", value: 2 });
  for (const replica of cluster.replicas) {
    ok(
      replica
        .getSet("SKU-E")
        .every((item) => item.tombstone || item.value !== 1),
    );
  }
});
