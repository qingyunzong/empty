/**
 * Versioned polygon store.
 *
 * Every accepted change (create / batch vertex move) is validated in full
 * BEFORE it is published. A rejected batch changes nothing: the previously
 * published versions stay readable forever via get(id, version).
 */

import { Point, isIntegerPoint } from './geometry.js';
import { Polygon, Conflict, validatePolygon } from './polygon.js';

export interface VertexMove {
  readonly ring: number; // 0 = outer, 1.. = holes
  readonly index: number; // vertex index within the ring
  readonly to: Point; // new integer position
}

export type PublishResult =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly conflicts: readonly Conflict[] };

interface MutablePolygon {
  outer: Point[];
  holes: Point[][];
}

function deepCopyPolygon(p: Polygon): MutablePolygon {
  return {
    outer: p.outer.map((v) => ({ x: v.x, y: v.y })),
    holes: p.holes.map((ring) => ring.map((v) => ({ x: v.x, y: v.y }))),
  };
}

export class PolygonStore {
  private readonly versions = new Map<string, MutablePolygon[]>();

  /** Validates and publishes the polygon as version 1 of `id`. */
  create(id: string, polygon: Polygon): PublishResult {
    if (this.versions.has(id)) {
      throw new Error(`polygon "${id}" already exists`);
    }
    const result = validatePolygon(polygon);
    if (!result.ok) return { ok: false, conflicts: result.conflicts };
    this.versions.set(id, [deepCopyPolygon(polygon)]);
    return { ok: true, version: 1 };
  }

  /**
   * Applies every move in the batch to a scratch copy of the latest version,
   * runs the full exact validation, and only then publishes the result as a
   * new version. Any conflict rejects the whole batch atomically.
   */
  moveVertices(id: string, moves: readonly VertexMove[]): PublishResult {
    const history = this.versions.get(id);
    if (!history) throw new Error(`unknown polygon "${id}"`);

    const draft = deepCopyPolygon(history[history.length - 1]!);
    const rings = [draft.outer, ...draft.holes];

    for (const move of moves) {
      const ring = rings[move.ring];
      if (!ring || move.index < 0 || move.index >= ring.length) {
        return {
          ok: false,
          conflicts: [
            {
              type: 'degenerate-ring',
              ring: move.ring,
              reason: `move targets missing vertex (ring ${move.ring}, index ${move.index})`,
            },
          ],
        };
      }
      if (!isIntegerPoint(move.to)) {
        return {
          ok: false,
          conflicts: [
            {
              type: 'degenerate-ring',
              ring: move.ring,
              reason: `move target (${move.to.x}, ${move.to.y}) is not an integer point`,
            },
          ],
        };
      }
      ring[move.index] = { x: move.to.x, y: move.to.y };
    }

    const result = validatePolygon(draft);
    if (!result.ok) return { ok: false, conflicts: result.conflicts };

    history.push(draft);
    return { ok: true, version: history.length };
  }

  /** Latest published version number, or 0 when the id is unknown. */
  latestVersion(id: string): number {
    return this.versions.get(id)?.length ?? 0;
  }

  /**
   * Returns a deep copy of the requested version (latest by default).
   * Every published version remains readable; callers cannot mutate the
   * stored history through the returned object.
   */
  get(id: string, version?: number): Polygon | undefined {
    const history = this.versions.get(id);
    if (!history) return undefined;
    const v = version ?? history.length;
    const found = history[v - 1];
    return found ? deepCopyPolygon(found) : undefined;
  }
}
