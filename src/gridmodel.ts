/**
 * Brute-force unit-grid reference model used to verify `RectStore.coverage`.
 *
 * Only meaningful for tiny integer grids: it evaluates every unit cell
 * [x, x+1) x [y, y+1) inside the bounding box of the input rectangles and
 * computes the exact covering source set per cell. `verifyCoverage` then checks
 * a sweep-line result cell by cell for area and source-set agreement.
 */

import {
  areaOf,
  compareIds,
  type CoverageRect,
  type Rect,
  type RectId,
} from "./rectstore.js";

export interface GridModel<Id extends RectId = RectId> {
  /** Number of unit cells covered by at least `k` sources. */
  readonly area: number;
  /** "x,y" -> canonical sorted source ids, only for cells with >= k sources. */
  readonly cells: ReadonlyMap<string, readonly Id[]>;
}

/** Computes the exact per-cell coverage for a tiny integer grid. */
export function gridCoverage<Id extends RectId>(
  entries: readonly (readonly [Id, Rect])[],
  k: number,
): GridModel<Id> {
  if (entries.length === 0) return { area: 0, cells: new Map() };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [, r] of entries) {
    minX = Math.min(minX, r.x0);
    minY = Math.min(minY, r.y0);
    maxX = Math.max(maxX, r.x1);
    maxY = Math.max(maxY, r.y1);
  }
  const cells = new Map<string, readonly Id[]>();
  let area = 0;
  for (let x = minX; x < maxX; x++) {
    for (let y = minY; y < maxY; y++) {
      const sources: Id[] = [];
      for (const [id, r] of entries) {
        if (r.x0 <= x && x + 1 <= r.x1 && r.y0 <= y && y + 1 <= r.y1) {
          sources.push(id);
        }
      }
      if (sources.length >= k) {
        sources.sort(compareIds);
        cells.set(`${x},${y}`, Object.freeze(sources));
        area += 1;
      }
    }
  }
  return { area, cells };
}

const sameSources = (a: readonly RectId[], b: readonly RectId[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Verifies a `coverage(k)` result against the brute-force grid model:
 *  1. total output area equals the number of unit cells with >= k sources;
 *  2. every unit cell inside every output rectangle has exactly the source
 *     set claimed by that rectangle;
 *  3. output rectangles are pairwise disjoint and together cover every
 *     >= k cell exactly once (holes stay uncovered).
 * Throws an Error describing the first mismatch found.
 */
export function verifyCoverage<Id extends RectId>(
  entries: readonly (readonly [Id, Rect])[],
  k: number,
  result: readonly CoverageRect<Id>[],
): void {
  const model = gridCoverage(entries, k);

  const totalArea = result.reduce((sum, c) => sum + areaOf(c.rect), 0);
  if (totalArea !== model.area) {
    throw new Error(
      `area mismatch: sweep reported ${totalArea}, grid model has ${model.area}`,
    );
  }

  const covered = new Map<string, readonly Id[]>();
  for (const c of result) {
    const { x0, y0, x1, y1 } = c.rect;
    if (c.sources.length < k) {
      throw new Error(
        `output rect (${x0},${y0},${x1},${y1}) has ${c.sources.length} sources < k=${k}`,
      );
    }
    const sorted = [...c.sources].sort(compareIds);
    if (!sameSources(sorted, c.sources)) {
      throw new Error(`sources not in canonical order on rect (${x0},${y0},${x1},${y1})`);
    }
    for (let x = x0; x < x1; x++) {
      for (let y = y0; y < y1; y++) {
        const key = `${x},${y}`;
        if (covered.has(key)) {
          throw new Error(`cell ${key} covered by more than one output rect`);
        }
        const expected = model.cells.get(key);
        if (expected === undefined) {
          throw new Error(`cell ${key} emitted but has < ${k} sources in grid model`);
        }
        if (!sameSources(expected, c.sources)) {
          throw new Error(
            `cell ${key} sources mismatch: sweep [${c.sources}] vs grid [${expected}]`,
          );
        }
        covered.set(key, c.sources);
      }
    }
  }

  for (const key of model.cells.keys()) {
    if (!covered.has(key)) {
      throw new Error(`cell ${key} has >= ${k} sources but is missing from output`);
    }
  }
}
