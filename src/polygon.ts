/**
 * Polygon model and full exact validation.
 *
 * A polygon is one outer ring plus zero or more hole rings. Rings are open
 * vertex lists (the last vertex connects back to the first). Ring 0 is the
 * outer ring; rings 1..n are holes.
 *
 * Validation checks EVERY pair of edges with exact integer predicates:
 *   - within a ring: non-adjacent edges must be fully disjoint (crossing,
 *     touching and collinear overlap are all conflicts);
 *   - adjacent edges must share only their common endpoint (no fold-back
 *     overlap);
 *   - across rings: any intersection at all (cross / touch / overlap) is a
 *     conflict;
 *   - every hole must lie strictly inside the outer ring and strictly
 *     outside every other hole (verified by exact point-in-ring tests once
 *     edge disjointness is established).
 */

import {
  Point,
  Ring,
  isIntegerPoint,
  samePoint,
  segmentRelation,
  pointInRing,
} from './geometry.js';

export interface Polygon {
  readonly outer: Ring;
  readonly holes: readonly Ring[];
}

/** Identifies one edge concretely: ring index, edge index, and its endpoints. */
export interface EdgeRef {
  readonly ring: number; // 0 = outer, 1.. = holes
  readonly edge: number; // edge i connects vertex i to vertex (i+1) mod n
  readonly a: Point;
  readonly b: Point;
}

export type Conflict =
  | {
      readonly type: 'self-intersection' | 'self-touch' | 'self-overlap';
      readonly edge1: EdgeRef;
      readonly edge2: EdgeRef;
      readonly point?: Point; // touch location when applicable
    }
  | {
      readonly type: 'ring-crossing' | 'ring-touch' | 'ring-overlap';
      readonly edge1: EdgeRef;
      readonly edge2: EdgeRef;
      readonly point?: Point;
    }
  | {
      readonly type: 'hole-outside-outer';
      readonly ring: number;
      readonly vertex: Point;
    }
  | {
      readonly type: 'hole-inside-hole';
      readonly ring: number;
      readonly otherRing: number;
      readonly vertex: Point;
    }
  | {
      readonly type: 'degenerate-ring';
      readonly ring: number;
      readonly reason: string;
    };

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly conflicts: readonly Conflict[] };

function ringsOf(p: Polygon): readonly Ring[] {
  return [p.outer, ...p.holes];
}

function edgeRef(ringIndex: number, edgeIndex: number, ring: Ring): EdgeRef {
  return {
    ring: ringIndex,
    edge: edgeIndex,
    a: ring[edgeIndex]!,
    b: ring[(edgeIndex + 1) % ring.length]!,
  };
}

export function validatePolygon(p: Polygon): ValidationResult {
  const conflicts: Conflict[] = [];
  const rings = ringsOf(p);

  // --- Structural checks -------------------------------------------------
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;
    if (ring.length < 3) {
      conflicts.push({
        type: 'degenerate-ring',
        ring: r,
        reason: `ring has ${ring.length} vertices, at least 3 required`,
      });
      continue;
    }
    for (let i = 0; i < ring.length; i++) {
      const v = ring[i]!;
      if (!isIntegerPoint(v)) {
        conflicts.push({
          type: 'degenerate-ring',
          ring: r,
          reason: `vertex ${i} (${v.x}, ${v.y}) is not an integer point`,
        });
      }
      if (samePoint(v, ring[(i + 1) % ring.length]!)) {
        conflicts.push({
          type: 'degenerate-ring',
          ring: r,
          reason: `zero-length edge ${i} at (${v.x}, ${v.y})`,
        });
      }
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };

  // --- All-pairs exact edge checks ---------------------------------------
  let crossRingConflict = false;

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const adjacent = j === i + 1 || (i === 0 && j === n - 1);
        const rel = segmentRelation(
          ring[i]!,
          ring[(i + 1) % n]!,
          ring[j]!,
          ring[(j + 1) % n]!,
        );
        if (rel.kind === 'none') continue;
        if (adjacent) {
          // Adjacent edges share exactly one endpoint by construction;
          // anything more (collinear fold-back) is an overlap conflict.
          if (rel.kind === 'overlap') {
            conflicts.push({
              type: 'self-overlap',
              edge1: edgeRef(r, i, ring),
              edge2: edgeRef(r, j, ring),
            });
          }
          continue;
        }
        const base = {
          edge1: edgeRef(r, i, ring),
          edge2: edgeRef(r, j, ring),
        };
        if (rel.kind === 'cross') {
          conflicts.push({ type: 'self-intersection', ...base });
        } else if (rel.kind === 'touch') {
          conflicts.push({ type: 'self-touch', ...base, point: rel.point });
        } else {
          conflicts.push({ type: 'self-overlap', ...base });
        }
      }
    }
  }

  for (let r1 = 0; r1 < rings.length; r1++) {
    for (let r2 = r1 + 1; r2 < rings.length; r2++) {
      const ring1 = rings[r1]!;
      const ring2 = rings[r2]!;
      for (let i = 0; i < ring1.length; i++) {
        for (let j = 0; j < ring2.length; j++) {
          const rel = segmentRelation(
            ring1[i]!,
            ring1[(i + 1) % ring1.length]!,
            ring2[j]!,
            ring2[(j + 1) % ring2.length]!,
          );
          if (rel.kind === 'none') continue;
          crossRingConflict = true;
          const base = {
            edge1: edgeRef(r1, i, ring1),
            edge2: edgeRef(r2, j, ring2),
          };
          if (rel.kind === 'cross') {
            conflicts.push({ type: 'ring-crossing', ...base });
          } else if (rel.kind === 'touch') {
            conflicts.push({ type: 'ring-touch', ...base, point: rel.point });
          } else {
            conflicts.push({ type: 'ring-overlap', ...base });
          }
        }
      }
    }
  }

  // --- Containment (only meaningful once rings are mutually disjoint) ----
  if (!crossRingConflict) {
    for (let h = 1; h < rings.length; h++) {
      const probe = rings[h]![0]!;
      if (!pointInRing(probe, rings[0]!)) {
        conflicts.push({ type: 'hole-outside-outer', ring: h, vertex: probe });
      }
      for (let k = 1; k < rings.length; k++) {
        if (k !== h && pointInRing(probe, rings[k]!)) {
          conflicts.push({
            type: 'hole-inside-hole',
            ring: h,
            otherRing: k,
            vertex: probe,
          });
        }
      }
    }
  }

  return conflicts.length === 0 ? { ok: true } : { ok: false, conflicts };
}
