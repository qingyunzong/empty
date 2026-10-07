import { Cluster } from "./cluster";
import { dominanceEvidence, resurrectionEvidence } from "./evidence";
import { mulberry32, pickInt, randomPartition } from "./random";
import {
  describeItem,
  itemId,
  sortedIds,
  visibleState,
  type VersionedValue,
} from "./versionedValue";

function print(lines: string[]): void {
  for (const line of lines) console.log(line);
}

function scenarioConcurrentConflict(): void {
  console.log("=== 场景 1: 并发写保留冲突集合(不以时钟覆盖) ===");
  const cluster = new Cluster(["R0", "R1", "R2"]);
  cluster.write("WIDGET", 10, 0, 3);
  cluster.partition([[0], [1, 2]]);
  cluster.write("WIDGET", 99, 0, 1);
  cluster.write("WIDGET", 20, 1, 2);
  cluster.heal();
  cluster.syncAll();
  print(dominanceEvidence(cluster, "WIDGET"));
  const result = cluster.read("WIDGET", [0, 1, 2]);
  console.log(`读结果: ${JSON.stringify(result.state)}`);
  console.log("");
}

function scenarioReadRepair(): void {
  console.log("=== 场景 2: 读获取至少两副本并修复缺版本 ===");
  const cluster = new Cluster(["R0", "R1", "R2"]);
  cluster.write("SKU-B", 5, 0, 1);
  console.log(`写入仅落 R0: R1 集合大小=${cluster.replicas[1].getSet("SKU-B").length}`);
  const result = cluster.read("SKU-B", [0, 1]);
  console.log(`读来源: [${result.sources.join(", ")}] 状态: ${JSON.stringify(result.state)}`);
  for (const repair of result.repairs) {
    console.log(
      `读修复: ${repair.replica} 补齐 ${repair.added.map(describeItem).join("; ")}`,
    );
  }
  console.log(`修复后 R1 集合大小=${cluster.replicas[1].getSet("SKU-B").length}`);
  console.log("");
}

function scenarioNoResurrection(): void {
  console.log("=== 场景 3: 随机分区 + 集合合并, 撤回旧版本不复活 ===");
  const rng = mulberry32(20261007);
  const cluster = new Cluster(["R0", "R1", "R2", "R3"]);
  const keys = ["SKU-A", "SKU-B"];
  const retracted = new Map<string, VersionedValue[]>();
  for (let step = 0; step < 200; step++) {
    const key = keys[pickInt(rng, 0, keys.length - 1)];
    const roll = pickInt(rng, 0, 99);
    if (roll < 20) {
      cluster.partition(randomPartition(rng, 4));
    } else if (roll < 30) {
      cluster.heal();
    } else if (roll < 60) {
      cluster.write(key, pickInt(rng, 0, 1000), pickInt(rng, 0, 3), pickInt(rng, 1, 3));
    } else if (roll < 75) {
      const coordinator = pickInt(rng, 0, 3);
      const doomed = cluster.replicas[coordinator]
        .getSet(key)
        .filter((item) => !item.tombstone);
      cluster.delete(key, coordinator, pickInt(rng, 1, 3));
      const list = retracted.get(key) ?? [];
      const known = new Set(list.map(itemId));
      retracted.set(key, [
        ...list,
        ...doomed.filter((item) => !known.has(itemId(item))),
      ]);
    } else {
      cluster.syncAll();
    }
  }
  cluster.heal();
  cluster.syncAll();
  const again = cluster.syncAll();
  console.log(`收敛核验: 反熵再次同步产生 ${again.length} 次传输 (0 即收敛)`);
  for (const key of keys) {
    const reference = sortedIds(cluster.replicas[0].getSet(key));
    const converged = cluster.replicas.every(
      (replica) => sortedIds(replica.getSet(key)).join("|") === reference.join("|"),
    );
    console.log(`key=${key} 全副本一致: ${converged} 最终状态: ${JSON.stringify(visibleState(cluster.replicas[0].getSet(key)))}`);
    print(resurrectionEvidence(cluster, key, retracted.get(key) ?? []));
  }
  console.log("");
  console.log("--- 支配关系证据样例 (SKU-A) ---");
  print(dominanceEvidence(cluster, "SKU-A"));
}

scenarioConcurrentConflict();
scenarioReadRepair();
scenarioNoResurrection();
