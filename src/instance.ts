/** 演示实例：8 个矩形、20x20 网格；旧布局违反 3 条对齐约束，需最小总移动修复。 */

import type { LayoutSpec, Placement } from './model.js';

export function demoSpec(): LayoutSpec {
  return {
    grid: 20,
    rects: [
      { id: 'A', minW: 3, maxW: 5, minH: 2, maxH: 4, oldX: 1, oldY: 1, oldW: 4, oldH: 3 },
      { id: 'B', minW: 3, maxW: 5, minH: 2, maxH: 4, oldX: 5, oldY: 1, oldW: 4, oldH: 3 },
      { id: 'C', minW: 2, maxW: 4, minH: 3, maxH: 5, oldX: 1, oldY: 5, oldW: 3, oldH: 4 },
      { id: 'D', minW: 4, maxW: 6, minH: 3, maxH: 4, oldX: 6, oldY: 6, oldW: 5, oldH: 3 },
      { id: 'E', minW: 2, maxW: 3, minH: 2, maxH: 3, oldX: 13, oldY: 1, oldW: 3, oldH: 2 },
      { id: 'F', minW: 3, maxW: 4, minH: 3, maxH: 4, oldX: 14, oldY: 4, oldW: 3, oldH: 3 },
      { id: 'G', minW: 2, maxW: 4, minH: 2, maxH: 3, oldX: 1, oldY: 12, oldW: 3, oldH: 2 },
      { id: 'H', minW: 5, maxW: 6, minH: 3, maxH: 4, oldX: 8, oldY: 13, oldW: 5, oldH: 3 },
    ],
    align: [
      { a: 'A', b: 'B', edge: 'top' },
      { a: 'A', b: 'C', edge: 'left' },
      { a: 'E', b: 'F', edge: 'right' },
      { a: 'D', b: 'H', edge: 'hcenter' },
      { a: 'G', b: 'H', edge: 'bottom' },
    ],
  };
}

/** 旧布局（用于展示违反的约束）。 */
export function oldLayout(spec: LayoutSpec): Placement[] {
  return spec.rects.map((r) => ({ id: r.id, x: r.oldX, y: r.oldY, w: r.oldW, h: r.oldH }));
}
