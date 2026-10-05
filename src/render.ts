import type { SnapshotRow } from "./types.js";

/** 确定性渲染：按行 id 排序的 JSON Lines（含结尾换行）。 */
export function renderExport(rows: readonly SnapshotRow[]): string {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lines = sorted.map((row) =>
    JSON.stringify({ id: row.id, generation: row.permissionGeneration, payload: row.payload }),
  );
  return lines.join("\n") + "\n";
}
