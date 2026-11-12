import { resolveExplicitPath } from './explicit.js';
import { buildIndex } from './geometry.js';
import { resolveImplicitPath } from './implicit.js';
import type { DataHeaderResult, Grid } from './types.js';

/**
 * Associate every data cell of a rectangular grid with its header ID path.
 *
 * Data cells carrying a non-empty `headers` list use explicit recursive
 * resolution; everything else falls back to geometric auto-association.
 * Results are ordered by each data cell's top-left grid position. The input
 * grid and its cells are only read, never mutated.
 *
 * @throws {HeaderAssociationError} when an explicit reference is missing,
 *         points at a data cell, or forms a dependency cycle.
 */
export function associateHeaders(grid: Grid): DataHeaderResult[] {
  const index = buildIndex(grid);
  const results: DataHeaderResult[] = [];

  for (const entry of index.ordered) {
    const { cell, rect } = entry;
    if (cell.role !== 'data') continue;

    const headerPath =
      cell.headers.length > 0
        ? resolveExplicitPath(cell, index.byId)
        : resolveImplicitPath(index, rect);

    results.push({
      dataId: cell.id,
      text: cell.text,
      headerPath,
    });
  }

  return results;
}
