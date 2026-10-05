/**
 * Exact planar geometry predicates for integer-coordinate polygons.
 *
 * All predicates are computed with BigInt arithmetic, so results are exact
 * for any safe-integer input (no floating-point rounding can flip a sign).
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Ring = readonly Point[];

export function isIntegerPoint(p: Point): boolean {
  return Number.isInteger(p.x) && Number.isInteger(p.y);
}

export function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Exact sign of the cross product (b - a) x (c - a). */
export function orient(a: Point, b: Point, c: Point): -1 | 0 | 1 {
  const v =
    (BigInt(b.x) - BigInt(a.x)) * (BigInt(c.y) - BigInt(a.y)) -
    (BigInt(b.y) - BigInt(a.y)) * (BigInt(c.x) - BigInt(a.x));
  return v > 0n ? 1 : v < 0n ? -1 : 0;
}

/** Assumes p is collinear with a-b; checks p lies within the closed segment. */
function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

export type SegmentRelation =
  | { readonly kind: 'none' }
  | { readonly kind: 'cross' } // proper interior crossing
  | { readonly kind: 'touch'; readonly point: Point } // single shared point, at least one endpoint involved
  | { readonly kind: 'overlap' }; // collinear with a shared sub-segment

/**
 * Exact intersection classification of closed segments p1p2 and p3p4.
 * Segments must be non-degenerate (p1 != p2, p3 != p4).
 */
export function segmentRelation(
  p1: Point,
  p2: Point,
  p3: Point,
  p4: Point,
): SegmentRelation {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);

  if (d1 !== 0 && d2 !== 0 && d1 !== d2 && d3 !== 0 && d4 !== 0 && d3 !== d4) {
    return { kind: 'cross' };
  }

  if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0) {
    // Collinear: project onto the dominant axis and compare intervals.
    const useX = p1.x !== p2.x || p3.x !== p4.x;
    const key = (p: Point) => (useX ? p.x : p.y);
    const lo = Math.max(Math.min(key(p1), key(p2)), Math.min(key(p3), key(p4)));
    const hi = Math.min(Math.max(key(p1), key(p2)), Math.max(key(p3), key(p4)));
    if (lo < hi) return { kind: 'overlap' };
    if (lo > hi) return { kind: 'none' };
    // Single shared point: it must be a common endpoint.
    for (const a of [p1, p2]) {
      for (const b of [p3, p4]) {
        if (samePoint(a, b)) return { kind: 'touch', point: a };
      }
    }
    return { kind: 'none' }; // unreachable for well-formed integer input
  }

  if (d1 === 0 && onSegment(p3, p4, p1)) return { kind: 'touch', point: p1 };
  if (d2 === 0 && onSegment(p3, p4, p2)) return { kind: 'touch', point: p2 };
  if (d3 === 0 && onSegment(p1, p2, p3)) return { kind: 'touch', point: p3 };
  if (d4 === 0 && onSegment(p1, p2, p4)) return { kind: 'touch', point: p4 };
  return { kind: 'none' };
}

/**
 * Exact point-in-ring test (crossing-number ray cast toward +x).
 * The point must not lie on any ring edge; enforce that beforehand with
 * segmentRelation checks (this library always does).
 */
export function pointInRing(p: Point, ring: Ring): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    if (a.y > p.y === b.y > p.y) continue; // edge does not straddle the ray
    // Sign of (x_intersection - x) via exact cross-multiplication.
    const dy = BigInt(b.y) - BigInt(a.y);
    const lhs = (BigInt(p.x) - BigInt(a.x)) * dy; // (x - ax) * dy
    const rhs = (BigInt(p.y) - BigInt(a.y)) * (BigInt(b.x) - BigInt(a.x)); // (y - ay) * dx
    const crossesRight = dy > 0n ? rhs > lhs : rhs < lhs;
    if (crossesRight) inside = !inside;
  }
  return inside;
}
