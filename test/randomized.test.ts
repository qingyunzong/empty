import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { Cluster } from "../src/cluster";
import { mulberry32, pickInt, randomPartition } from "../src/random";
import {
  itemId,
  sortedIds,
  type VersionedValue,
} from "../src/versionedValue";
import { dominates } from "../src/versionVector";

const NODE_IDS = ["R0", "R1", "R2", "R3"];
const KEYS = ["SKU-A", "SKU-B", "SKU-C"];

interface ModelResult {
  cluster: Cluster;
  retracted: Map<string, Set<string>>;
}

function runModel(seed: number, steps: number): ModelResult {
  const rng = mulberry32(seed);
  const cluster = new Cluster(NODE_IDS);
  const retracted = new Map<string, Set<string>>();

  const assertLocalInvariant = (): void => {
    for (const replica of cluster.replicas) {
      for (const key of KEYS) {
        const set = replica.getSet(key);
        for (const a of set) {
          for (const b of set) {
            if (a !== b) {
              ok(
                !dominates(a.vv, b.vv),
                `${replica.id}/${key} 内存在被支配版本未裁剪`,
              );
            }
          }
        }
      }
    }
  };

  for (let step = 0; step < steps; step++) {
    const key = KEYS[pickInt(rng, 0, KEYS.length - 1)];
    const roll = pickInt(rng, 0, 99);
    if (roll < 15) {
      cluster.partition(randomPartition(rng, NODE_IDS.length));
    } else if (roll < 25) {
      cluster.heal();
    } else if (roll < 55) {
      cluster.write(
        key,
        pickInt(rng, 0, 1000),
        pickInt(rng, 0, NODE_IDS.length - 1),
        pickInt(rng, 1, 3),
      );
    } else if (roll < 70) {
      const coordinator = pickInt(rng, 0, NODE_IDS.length - 1);
      const doomed = cluster.replicas[coordinator]
        .getSet(key)
        .filter((item) => !item.tombstone);
      cluster.delete(key, coordinator, pickInt(rng, 1, 3));
      const set = retracted.get(key) ?? new Set<string>();
      for (const item of doomed) set.add(itemId(item));
      retracted.set(key, set);
    } else if (roll < 85) {
      const coordinator = pickInt(rng, 0, NODE_IDS.length - 1);
      const reachable = cluster.reachableFrom(coordinator);
      if (reachable.length >= 2) {
        const r = Math.max(2, pickInt(rng, 2, reachable.length));
        cluster.read(key, reachable.slice(0, r));
      }
    } else {
      cluster.syncAll();
    }
    assertLocalInvariant();
  }
  cluster.heal();
  cluster.syncAll();
  return { cluster, retracted };
}

function serialize(cluster: Cluster): string {
  return cluster.replicas
    .map((replica) =>
      KEYS.map((key) => sortedIds(replica.getSet(key)).join(",")).join(";"),
    )
    .join("|");
}

test("随机分区 + 集合合并: 收敛且撤回旧版本不复活", () => {
  for (const seed of [1, 7, 42, 1337, 20261007]) {
    const { cluster, retracted } = runModel(seed, 400);
    equal(cluster.syncAll().length, 0, `seed=${seed} 反熵后未收敛`);
    for (const key of KEYS) {
      const reference = sortedIds(cluster.replicas[0].getSet(key)).join(",");
      for (const replica of cluster.replicas) {
        equal(
          sortedIds(replica.getSet(key)).join(","),
          reference,
          `seed=${seed} ${replica.id}/${key} 与 R0 不一致`,
        );
        const doomed = retracted.get(key) ?? new Set<string>();
        for (const item of replica.getSet(key)) {
          ok(
            item.tombstone || !doomed.has(itemId(item)),
            `seed=${seed} ${replica.id}/${key} 复活了已撤回版本 ${itemId(item)}`,
          );
        }
      }
    }
  }
});

test("相同种子产生相同终态(确定性)", () => {
  const first = runModel(99, 300);
  const second = runModel(99, 300);
  equal(serialize(first.cluster), serialize(second.cluster));
});

test("终态可见性: 存活版本不被任何墓碑支配", () => {
  const { cluster } = runModel(2026, 400);
  for (const key of KEYS) {
    const set = cluster.replicas[0].getSet(key);
    const tombstones = set.filter((item) => item.tombstone);
    const live = set.filter((item) => !item.tombstone);
    for (const item of live) {
      for (const tombstone of tombstones) {
        ok(!dominates(tombstone.vv, item.vv));
      }
    }
  }
});

test("模型对照: 去掉墓碑的朴素并集会复活撤回版本", () => {
  const cluster = new Cluster(["R0", "R1"]);
  cluster.write("SKU-X", 1, 0, 2);
  const deleted: VersionedValue = cluster.replicas[0].getSet("SKU-X")[0];
  cluster.delete("SKU-X", 0, 1);
  const naiveUnion = [
    ...cluster.replicas[0].getSet("SKU-X").filter((item) => !item.tombstone),
    ...cluster.replicas[1].getSet("SKU-X"),
  ];
  ok(naiveUnion.some((item) => itemId(item) === itemId(deleted)));
  cluster.syncAll();
  ok(
    cluster.replicas[1]
      .getSet("SKU-X")
      .every((item) => itemId(item) !== itemId(deleted)),
  );
  deepEqual(cluster.replicas[1].getSet("SKU-X").length, 1);
});
