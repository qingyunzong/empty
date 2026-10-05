import { createHash } from "node:crypto";
import type { Cell } from "./types.js";

/** 源数据的规范序列化形式（与字段顺序、空白无关）。 */
export function canonicalCells(cells: readonly Cell[]): string {
  return JSON.stringify(
    cells.map((c) => (c === null ? null : [c.value, c.weight])),
  );
}

/** 源摘要：对规范形式取 SHA-256。 */
export function sourceDigest(cells: readonly Cell[]): string {
  return createHash("sha256").update(canonicalCells(cells)).digest("hex");
}
