import type { Correction, Item } from "./types.js";
import { validateItems } from "./solver.js";

/** 应用时码更正：按 id 覆盖字段，返回新数组并重新校验。 */
export function applyCorrections(items: Item[], corrections: Correction[]): Item[] {
  validateItems(items);
  const byId = new Map(items.map((it) => [it.id, { ...it }]));
  for (const c of corrections) {
    const target = byId.get(c.id);
    if (!target) throw new Error(`更正指向未知 id：${c.id}`);
    if (c.start !== undefined) target.start = c.start;
    if (c.end !== undefined) target.end = c.end;
    if (c.priority !== undefined) target.priority = c.priority;
  }
  const corrected = [...byId.values()];
  validateItems(corrected);
  return corrected;
}
