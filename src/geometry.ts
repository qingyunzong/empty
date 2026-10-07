/**
 * Exact integer geometry primitives.
 *
 * All predicates are evaluated with BigInt arithmetic, so results are exact
 * for any safe-integer coordinates (no floating-point rounding).
 */

export interface Point {
  x: number;
  y: number;
}

/** Twice the signed area of triangle (a, b, c); sign gives orientation. */
export function orient(a: Point, b: Point, c: Point): bigint {
  return (
    (BigInt(b.x) - BigInt(a.x)) * (BigInt(c.y) - BigInt(a.y)) -
    (BigInt(b.y) - BigInt(a.y)) * (BigInt(c.x) - BigInt(a.x))
  );
}

/** True when p lies on the closed segment ab (p must be collinear-checked inside). */
export function onSegment(a: Point, b: Point, p: Point): boolean {
  if (orient(a, b, p) !== 0n) return false;
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

export type SegmentIntersection =
  | { type: "none" }
  | /** Proper crossing of the two segment interiors. */ { type: "cross" }
  | /** Segments share exactly one point (an endpoint of at least one). */ {
      type: "touch";
      point: Point;
    }
  | /** Collinear segments sharing more than one point. */ {
      type: "overlap";
      from: Point;
      to: Point;
    };

/**
 * Exact segment-segment intersection. Any result other than "none"
 * (including a mere touch) is reported; callers decide how to treat it.
 */
export function segmentIntersection(
  p1: Point,
  p2: Point,
  p3: Point,
  p4: Point,
): SegmentIntersection {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);

  if (
    ((d1 > 0n && d2 < 0n) || (d1 < 0n && d2 > 0n)) &&
    ((d3 > 0n && d4 < 0n) || (d3 < 0n && d4 > 0n))
  ) {
    return { type: "cross" };
  }

  if (d1 === 0n && d2 === 0n) {
    // Collinear: gather the endpoints of either segment that lie on both.
    const shared: Point[] = [];
    for (const p of [p1, p2, p3, p4]) {
      if (
        onSegment(p1, p2, p) &&
        onSegment(p3, p4, p) &&
        !shared.some((q) => q.x === p.x && q.y === p.y)
      ) {
        shared.push(p);
      }
    }
    if (shared.length === 0) return { type: "none" };
    if (shared.length === 1) return { type: "touch", point: shared[0]! };
    // Extremes of the shared range on the dominant axis.
    const useX = p1.x !== p2.x || p3.x !== p4.x;
    shared.sort((a, b) => (useX ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x));
    return {
      type: "overlap",
      from: shared[0]!,
      to: shared[shared.length - 1]!,
    };
  }

  if (d1 === 0n && onSegment(p3, p4, p1)) return { type: "touch", point: p1 };
  if (d2 === 0n && onSegment(p3, p4, p2)) return { type: "touch", point: p2 };
  if (d3 === 0n && onSegment(p1, p2, p3)) return { type: "touch", point: p3 };
  if (d4 === 0n && onSegment(p1, p2, p4)) return { type: "touch", point: p4 };
  return { type: "none" };
}

/**
 * Exact point-in-ring test (ray casting with BigInt arithmetic).
 * The point must not lie on the ring boundary; check edges first.
 */
export function pointInRing(p: Point, ring: Point[]): boolean {
  let inside = false;
  const px = BigInt(p.x);
  const py = BigInt(p.y);
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    if (a.y > p.y === b.y > p.y) continue;
    // Does the edge cross the horizontal ray y = p.y, x > p.x ?
    // x_intersect = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y)
    // Compare p.x < x_intersect without division.
    const dy = BigInt(b.y - a.y);
    const lhs = (px - BigInt(a.x)) * dy;
    const rhs = (py - BigInt(a.y)) * BigInt(b.x - a.x);
    const intersectRightOfP = dy > 0n ? lhs < rhs : lhs > rhs;
    if (intersectRightOfP) inside = !inside;
  }
  return inside;
}

/** Twice the signed area of a ring (positive = counter-clockwise). */
export function signedArea2(ring: Point[]): bigint {
  let sum = 0n;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    sum += BigInt(a.x) * BigInt(b.y) - BigInt(b.x) * BigInt(a.y);
  }
  return sum;
}
