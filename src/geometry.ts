import type { Cell, CellRect, Grid, IndexedCell } from './types.js';

export interface GridIndex {
  /** Unique cells keyed by their ID. */
  byId: Map<string, Cell>;
  /** Geometry of every unique cell, keyed by ID. */
  rectById: Map<string, CellRect>;
  /** Unique cells ordered by top-left (row, then column). */
  ordered: IndexedCell[];
}

/**
 * Walk the rectangular grid and derive each unique cell's extent.
 *
 * Spanned slots point at the same object, so the first sighting opens a
 * rectangle and every later sighting only extends its bounds.
 */
export function buildIndex(grid: Grid): GridIndex {
  const byId = new Map<string, Cell>();
  const rectById = new Map<string, CellRect>();
  const firstSeen = new Map<Cell, CellRect>();

  for (let row = 0; row < grid.length; row += 1) {
    const cells = grid[row];
    if (cells === undefined) continue;
    for (let col = 0; col < cells.length; col += 1) {
      const cell = cells[col];
      if (cell === undefined) continue;
      const existing = firstSeen.get(cell);
      if (existing === undefined) {
        const rect: CellRect = {
          rowStart: row,
          rowEnd: row,
          colStart: col,
          colEnd: col,
        };
        firstSeen.set(cell, rect);
        rectById.set(cell.id, rect);
        byId.set(cell.id, cell);
      } else {
        if (row > existing.rowEnd) existing.rowEnd = row;
        if (col > existing.colEnd) existing.colEnd = col;
      }
    }
  }

  const ordered: IndexedCell[] = [...firstSeen.entries()]
    .map(([cell, rect]) => ({ cell, rect }))
    .sort((a, b) => compareTopLeft(a.rect, b.rect));

  return { byId, rectById, ordered };
}

/** Deterministic top-left ordering: row first, then column. */
export function compareTopLeft(a: CellRect, b: CellRect): number {
  if (a.rowStart !== b.rowStart) return a.rowStart - b.rowStart;
  return a.colStart - b.colStart;
}

function rangesOverlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): boolean {
  return startA <= endB && startB <= endA;
}

/** True when the header shares at least one row with the data cell. */
export function coversAnyRow(header: CellRect, data: CellRect): boolean {
  return rangesOverlap(header.rowStart, header.rowEnd, data.rowStart, data.rowEnd);
}

/** True when the header shares at least one column with the data cell. */
export function coversAnyColumn(header: CellRect, data: CellRect): boolean {
  return rangesOverlap(
    header.colStart,
    header.colEnd,
    data.colStart,
    data.colEnd,
  );
}

/** True when the whole header rectangle sits strictly to the left of data. */
export function isEntirelyLeft(header: CellRect, data: CellRect): boolean {
  return header.colEnd < data.colStart;
}

/** True when the whole header rectangle sits strictly above data. */
export function isEntirelyAbove(header: CellRect, data: CellRect): boolean {
  return header.rowEnd < data.rowStart;
}
