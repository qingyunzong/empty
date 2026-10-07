import { test } from "node:test";
import { ok } from "node:assert/strict";
import { Cluster } from "../src/cluster";
import { dominanceEvidence, resurrectionEvidence } from "../src/evidence";
import type { VersionedValue } from "../src/versionedValue";

test("支配关系证据包含并发与支配判定", () => {
  const cluster = new Cluster(["R0", "R1", "R2"]);
  cluster.write("WIDGET", 10, 0, 3);
  cluster.partition([[0], [1, 2]]);
  cluster.write("WIDGET", 99, 0, 1);
  cluster.write("WIDGET", 20, 1, 2);
  cluster.heal();
  cluster.syncAll();
  const lines = dominanceEvidence(cluster, "WIDGET").join("\n");
  ok(lines.includes("支配关系证据"));
  ok(lines.includes("并发"));
  ok(lines.includes("不以时钟覆盖"));
  ok(lines.includes("{R0:2}"));
  ok(lines.includes("{R0:1,R1:1}"));
});

test("支配证据标注被裁剪的旧版本", () => {
  const cluster = new Cluster(["R0", "R1"]);
  cluster.write("SKU", 1, 0, 2);
  cluster.write("SKU", 2, 0, 1);
  const lines = dominanceEvidence(cluster, "SKU").join("\n");
  ok(lines.includes("支配"));
  ok(lines.includes("被裁剪"));
});

test("复活核验证据: 通过时明确给出结论", () => {
  const cluster = new Cluster(["R0", "R1", "R2"]);
  cluster.write("SKU-D", 7, 0, 3);
  const retracted: VersionedValue[] = cluster.replicas[0].getSet("SKU-D");
  cluster.delete("SKU-D", 0, 3);
  cluster.syncAll();
  const lines = resurrectionEvidence(cluster, "SKU-D", retracted).join("\n");
  ok(lines.includes("核验通过"));
  ok(lines.includes("已撤回版本数: 1"));
});

test("复活核验证据: 人为注入复活时判定失败", () => {
  const cluster = new Cluster(["R0", "R1"]);
  cluster.write("SKU-Z", 3, 0, 2);
  const retracted: VersionedValue[] = cluster.replicas[0].getSet("SKU-Z");
  const lines = resurrectionEvidence(cluster, "SKU-Z", retracted).join("\n");
  ok(lines.includes("核验失败"));
});
