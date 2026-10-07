/**
 * Polygon model and full exact validation.
 *
 * A polygon is an outer ring plus zero or more hole rings. A polygon is
 * valid when:
 *  - every ring has >= 3 vertices, safe-integer coordinates, no zero-length
 *    edges and non-zero signed area;
 *  - no two edges intersect in any way — crossing, touching or overlapping
 *    all count as conflicts (adjacent edges of a ring may share exactly
 *    their common endpoint);
 *  - every hole lies strictly inside the outer ring and outside every
 *    other hole.
 *
 * The edge checks are an exhaustive all-edge-pairs exact scan (BigInt
 * arithmetic), which doubles as the ground-truth oracle for tests.
 */

import {
  Point,
  SegmentIntersection,
  onSegment,
  orient,
  pointInRing,
  segmentIntersection,
  signedArea2,
} from "./geometry";

export interface Polygon {
  outer: Point[];
  holes: Point[][];
}

/** Ring 0 is the outer ring; ring k >= 1 is holes[k - 1]. */
export interface EdgeRef {
  ring: number;
  /** Edge i connects vertex i to vertex (i + 1) mod n of its ring. */
  edge: number;
}

export type Conflict =
  | {
      kind: "self-intersection" | "ring-intersection";
      a: EdgeRef;
      b: EdgeRef;
      intersection: Exclude<SegmentIntersection, { type: "none" }>;
      message: string;
    }
  | { kind: "hole-outside-outer"; hole: number; message: string }
  | { kind: "nested-hole"; hole: number; container: number; message: string }
  | { kind: "degenerate-ring"; ring: number; reason: string; message: string }
  | {
      kind: "invalid-coordinate";
      ring: number;
      vertex: number;
      message: string;
    };

export function ringLabel(ring: number): string {
  return ring === 0 ? "outer" : `hole${ring - 1}`;
}

export function edgeLabel(poly: Polygon, ref: EdgeRef): string {
  const ring = getRing(poly, ref.ring);
  const n = ring.length;
  const p = ring[ref.edge % n]!;
  const q = ring[(ref.edge + 1) % n]!;
  return `${ringLabel(ref.ring)} edge ${ref.edge} (${p.x},${p.y})->(${q.x},${q.y})`;
}

export function getRing(poly: Polygon, ring: number): Point[] {
  return ring === 0 ? poly.outer : poly.holes[ring - 1]!;
}

export function ringCount(poly: Polygon): number {
  return 1 + poly.holes.length;
}

interface FlatEdge {
  ref: EdgeRef;
  p: Point;
  q: Point;
}

function structuralConflicts(poly: Polygon): Conflict[] {
  const conflicts: Conflict[] = [];
  for (let r = 0; r < ringCount(poly); r++) {
    const ring = getRing(poly, r);
    const label = ringLabel(r);
    let hasInvalidCoordinate = false;
    for (let i = 0; i < ring.length; i++) {
      const v = ring[i]!;
      if (
        !Number.isSafeInteger(v.x) ||
        !Number.isSafeInteger(v.y)
      ) {
        hasInvalidCoordinate = true;
        conflicts.push({
          kind: "invalid-coordinate",
          ring: r,
          vertex: i,
          message: `${label} vertex ${i} (${v.x},${v.y}) is not a safe-integer coordinate`,
        });
      }
    }
    // BigInt-based checks below require integer coordinates.
    if (hasInvalidCoordinate) continue;
    if (ring.length < 3) {
      conflicts.push({
        kind: "degenerate-ring",
        ring: r,
        reason: "too-few-vertices",
        message: `${label} has ${ring.length} vertices, at least 3 required`,
      });
      continue;
    }
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      if (a.x === b.x && a.y === b.y) {
        conflicts.push({
          kind: "degenerate-ring",
          ring: r,
          reason: "zero-length-edge",
          message: `${label} edge ${i} has zero length at (${a.x},${a.y})`,
        });
      }
    }
  }
  return conflicts;
}

/**
 * Exhaustive all-edge-pairs exact intersection scan over every ring.
 * Adjacent edges of the same ring may share their common endpoint, but a
 * collinear overlap (spike) is still a conflict. Every other pair reports
 * any intersection at all — cross, touch or overlap.
 */
export function edgeIntersectionConflicts(poly: Polygon): Conflict[] {
  const edges: FlatEdge[] = [];
  for (let r = 0; r < ringCount(poly); r++) {
    const ring = getRing(poly, r);
    for (let i = 0; i < ring.length; i++) {
      edges.push({
        ref: { ring: r, edge: i },
        p: ring[i]!,
        q: ring[(i + 1) % ring.length]!,
      });
    }
  }

  const conflicts: Conflict[] = [];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const ea = edges[i]!;
      const eb = edges[j]!;
      const hit = segmentIntersection(ea.p, ea.q, eb.p, eb.q);
      if (hit.type === "none") continue;

      const sameRing = ea.ref.ring === eb.ref.ring;
      if (sameRing) {
        const n = getRing(poly, ea.ref.ring).length;
        const adjacent =
          (ea.ref.edge + 1) % n === eb.ref.edge ||
          (eb.ref.edge + 1) % n === ea.ref.edge;
        // Adjacent edges legitimately share exactly one endpoint.
        if (adjacent && hit.type === "touch") continue;
        // A collinear adjacent pair extending a straight line shares only
        // the endpoint (reported as "touch" above); an "overlap" here is a
        // backtracking spike and always a conflict.
      }

      const kind = sameRing ? "self-intersection" : "ring-intersection";
      const what =
        hit.type === "cross"
          ? "crosses"
          : hit.type === "touch"
            ? `touches at (${hit.point.x},${hit.point.y})`
            : `overlaps from (${hit.from.x},${hit.from.y}) to (${hit.to.x},${hit.to.y})`;
      conflicts.push({
        kind,
        a: ea.ref,
        b: eb.ref,
        intersection: hit,
        message: `${edgeLabel(poly, ea.ref)} ${what} ${edgeLabel(poly, eb.ref)}`,
      });
    }
  }
  return conflicts;
}

/** Containment checks: holes strictly inside the outer ring, never nested. */
export function containmentConflicts(poly: Polygon): Conflict[] {
  const conflicts: Conflict[] = [];
  for (let h = 0; h < poly.holes.length; h++) {
    const probe = poly.holes[h]![0]!;
    if (!pointInRing(probe, poly.outer)) {
      conflicts.push({
        kind: "hole-outside-outer",
        hole: h,
        message: `${ringLabel(h + 1)} vertex 0 (${probe.x},${probe.y}) lies outside the outer ring`,
      });
    }
    for (let k = 0; k < poly.holes.length; k++) {
      if (k === h) continue;
      if (pointInRing(probe, poly.holes[k]!)) {
        conflicts.push({
          kind: "nested-hole",
          hole: h,
          container: k,
          message: `${ringLabel(h + 1)} lies inside ${ringLabel(k + 1)}`,
        });
      }
    }
  }
  return conflicts;
}

/**
 * Full validation: structural checks, then the exhaustive all-edge-pairs
 * exact scan, then containment. Edge evidence is returned for every
 * conflicting pair. Containment is only evaluated when no edge conflicts
 * exist, since boundary contact would make point-in-ring ambiguous.
 */
export function validatePolygon(poly: Polygon): Conflict[] {
  const structural = structuralConflicts(poly);
  if (structural.length > 0) return structural;
  const edgeConflicts = edgeIntersectionConflicts(poly);
  if (edgeConflicts.length > 0) return edgeConflicts;
  return containmentConflicts(poly);
}

export function isValidPolygon(poly: Polygon): boolean {
  return validatePolygon(poly).length === 0;
}

// Re-exported for convenience of consumers building evidence output.
export { onSegment, orient, pointInRing, segmentIntersection, signedArea2 };
