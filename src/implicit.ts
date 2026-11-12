import {
  compareTopLeft,
  coversAnyColumn,
  coversAnyRow,
  isEntirelyAbove,
  isEntirelyLeft,
  type GridIndex,
} from './geometry.js';
import type { Cell, CellRect } from './types.js';

/**
 * Auto-associate a data cell that has no explicit `headers` list.
 *
 * Row headers come first: header cells with `scope === 'row'` that cover at
 * least one row of the data cell and whose whole rectangle lies to its left.
 * Column headers follow: `scope === 'col'` headers covering at least one
 * column and lying wholly above. Within each group candidates are sorted by
 * top-left (row, then column) and de-duplicated by ID. How often a header is
 * referenced never influences the order.
 */
export function resolveImplicitPath(index: GridIndex, dataRect: CellRect): string[] {
  const rowCandidates: Cell[] = [];
  const colCandidates: Cell[] = [];

  for (const entry of index.ordered) {
    if (entry.cell.role !== 'header') continue;
    const rect = entry.rect;
    if (entry.cell.scope === 'row') {
      if (coversAnyRow(rect, dataRect) && isEntirelyLeft(rect, dataRect)) {
        rowCandidates.push(entry.cell);
      }
    } else if (entry.cell.scope === 'col') {
      if (coversAnyColumn(rect, dataRect) && isEntirelyAbove(rect, dataRect)) {
        colCandidates.push(entry.cell);
      }
    }
  }

  const rectOf = (cell: Cell): CellRect => index.rectById.get(cell.id)!;
  const byTopLeft = (a: Cell, b: Cell): number =>
    compareTopLeft(rectOf(a), rectOf(b));
  const ordered = [
    ...rowCandidates.sort(byTopLeft),
    ...colCandidates.sort(byTopLeft),
  ];
  const path: string[] = [];
  const seen = new Set<string>();
  for (const cell of ordered) {
    if (!seen.has(cell.id)) {
      seen.add(cell.id);
      path.push(cell.id);
    }
  }
  return path;
}
