/**
 * 微小网格穷举对照器：枚举全部可行布局取最小总移动距离。
 * 不做任何基于代价的剪枝，仅做可行性剪枝，用于交叉校验分支定界结果。
 */

import type { LayoutSpec, Placement } from './model.js';
import { checkPartial, allSatisfied, totalMovement } from './constraints.js';

export interface ExhaustiveResult {
  objective: number | null;
  layout: Placement[] | null;
  /** 可行完整布局总数 */
  feasibleCount: number;
  /** 枚举到的完整布局总数（含不可行） */
  leafCount: number;
}

export function exhaustiveSolve(spec: LayoutSpec): ExhaustiveResult {
  const rects = spec.rects;
  const n = rects.length;
  let best: Placement[] | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  let feasibleCount = 0;
  let leafCount = 0;
  const current: Placement[] = [];

  function walk(depth: number): void {
    if (depth === n) {
      leafCount++;
      if (!allSatisfied(checkPartial(spec, current))) return;
      feasibleCount++;
      const cost = totalMovement(spec, current);
      if (cost < bestCost) {
        bestCost = cost;
        best = current.map((p) => ({ ...p }));
      }
      return;
    }
    const r = rects[depth]!;
    for (let w = r.minW; w <= r.maxW; w++) {
      for (let h = r.minH; h <= r.maxH; h++) {
        for (let x = 0; x + w <= spec.grid; x++) {
          for (let y = 0; y + h <= spec.grid; y++) {
            current.push({ id: r.id, x, y, w, h });
            if (allSatisfied(checkPartial(spec, current))) walk(depth + 1);
            current.pop();
          }
        }
      }
    }
  }

  walk(0);
  return {
    objective: best ? bestCost : null,
    layout: best,
    feasibleCount,
    leafCount,
  };
}
