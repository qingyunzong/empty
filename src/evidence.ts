import type { Cluster } from "./cluster";
import { compare, format } from "./versionVector";
import {
  describeItem,
  itemId,
  type VersionedValue,
} from "./versionedValue";

export interface ObservedItem {
  item: VersionedValue;
  holders: string[];
}

export function observe(cluster: Cluster, key: string): ObservedItem[] {
  const byId = new Map<string, ObservedItem>();
  for (const replica of cluster.replicas) {
    for (const item of replica.getSet(key)) {
      const id = itemId(item);
      const entry = byId.get(id);
      if (entry) entry.holders.push(replica.id);
      else byId.set(id, { item, holders: [replica.id] });
    }
  }
  return [...byId.values()];
}

export function dominanceEvidence(cluster: Cluster, key: string): string[] {
  const observed = observe(cluster, key);
  const lines: string[] = [];
  lines.push(`key=${key} 观测到 ${observed.length} 个版本:`);
  observed.forEach((entry, index) => {
    lines.push(
      `  v${index} ${describeItem(entry.item)}  持有副本: [${entry.holders.join(", ")}]`,
    );
  });
  lines.push("支配关系证据:");
  if (observed.length < 2) lines.push("  (单一版本, 无并发)");
  for (let i = 0; i < observed.length; i++) {
    for (let j = i + 1; j < observed.length; j++) {
      const a = observed[i];
      const b = observed[j];
      const order = compare(a.item.vv, b.item.vv);
      const la = `v${i}${format(a.item.vv)}`;
      const lb = `v${j}${format(b.item.vv)}`;
      if (order === "dominates") {
        lines.push(`  ${la} 支配 ${lb} -> 集合合并时 ${lb} 被裁剪`);
      } else if (order === "dominated") {
        lines.push(`  ${lb} 支配 ${la} -> 集合合并时 ${la} 被裁剪`);
      } else if (order === "equal") {
        lines.push(`  ${la} 等价 ${lb}`);
      } else {
        lines.push(`  ${la} 并发 ${lb} -> 冲突集合同时保留, 不以时钟覆盖`);
      }
    }
  }
  return lines;
}

export function resurrectionEvidence(
  cluster: Cluster,
  key: string,
  retracted: readonly VersionedValue[],
): string[] {
  const lines: string[] = [];
  const retractedIds = new Set(retracted.map(itemId));
  const resurrected: string[] = [];
  for (const replica of cluster.replicas) {
    for (const item of replica.getSet(key)) {
      if (!item.tombstone && retractedIds.has(itemId(item))) {
        resurrected.push(`${replica.id}:${describeItem(item)}`);
      }
    }
  }
  lines.push(`key=${key} 已撤回版本数: ${retracted.length}`);
  for (const item of retracted) {
    lines.push(`  已撤回: ${describeItem(item)}`);
  }
  if (resurrected.length === 0) {
    lines.push("核验通过: 集合合并后所有副本均未复活任何已撤回版本");
  } else {
    lines.push(`核验失败: 检测到复活 -> ${resurrected.join(", ")}`);
  }
  return lines;
}
