import type { Certificate, Item } from "./types.js";
import { validateItems } from "./solver.js";

/**
 * 校验层分配证书：
 * 1. 选中 id 存在且不重复，assignment 与 selected 一一对应；
 * 2. 层号在 [0, k) 内；
 * 3. 同层字幕两两不重叠（半开区间，end <= start 视为相接不重叠）；
 * 4. 证书收益等于选中字幕 priority 之和，count 一致。
 * 返回 null 表示合法，否则返回错误描述。
 */
export function verifyCertificate(items: Item[], k: number, cert: Certificate): string | null {
  validateItems(items);
  if (cert.k !== k) return `证书 k=${cert.k} 与输入 k=${k} 不符`;
  const byId = new Map(items.map((it) => [it.id, it]));
  const selected = cert.selected;
  if (new Set(selected).size !== selected.length) return "selected 含重复 id";
  for (const id of selected) {
    if (!byId.has(id)) return `selected 含未知 id：${id}`;
  }
  const sorted = [...selected].sort((a, b) => a - b);
  if (selected.some((id, i) => id !== sorted[i])) return "selected 未按 id 升序";
  if (cert.count !== selected.length) return `count=${cert.count} 与 selected 长度不符`;

  const layerOf = new Map<number, number>();
  for (const a of cert.assignment) {
    if (!byId.has(a.id)) return `assignment 含未知 id：${a.id}`;
    if (!Number.isInteger(a.layer) || a.layer < 0 || a.layer >= k) {
      return `id=${a.id} 层号 ${a.layer} 越界 [0, ${k})`;
    }
    if (layerOf.has(a.id)) return `assignment 含重复 id：${a.id}`;
    layerOf.set(a.id, a.layer);
  }
  for (const id of selected) {
    if (!layerOf.has(id)) return `选中字幕 id=${id} 缺少层分配`;
  }
  for (const id of layerOf.keys()) {
    if (!selected.includes(id)) return `id=${id} 被分配层却不在 selected 中`;
  }

  const byLayer = new Map<number, Item[]>();
  for (const id of selected) {
    const layer = layerOf.get(id)!;
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer)!.push(byId.get(id)!);
  }
  for (const [layer, list] of byLayer) {
    const sortedList = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i + 1 < sortedList.length; i++) {
      if (sortedList[i].end > sortedList[i + 1].start) {
        return `第 ${layer} 层重叠：id=${sortedList[i].id} 与 id=${sortedList[i + 1].id}`;
      }
    }
  }

  const profit = selected.reduce((sum, id) => sum + byId.get(id)!.priority, 0);
  if (profit !== cert.profit) return `证书收益 ${cert.profit} 与实际 ${profit} 不符`;
  return null;
}
