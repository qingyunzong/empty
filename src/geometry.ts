/** A 2D point. Polygon vertices always carry integer coordinates. */
export interface Point {
  x: number;
  y: number;
}

export function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export interface ClosestOnSegment {
  /** Closest point on the segment (may be fractional before snapping). */
  point: Point;
  /** Parameter in [0, 1] along the segment. */
  t: number;
  /** Squared distance from the query point to the closest point. */
  dist2: number;
}

/** Closest point on segment ab to point p, with squared distance. */
export function closestPointOnSegment(p: Point, a: Point, b: Point): ClosestOnSegment {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = 0;
  if (len2 > 0) {
    t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const point = { x: a.x + t * abx, y: a.y + t * aby };
  return { point, t, dist2: dist2(p, point) };
}

/** Round to the nearest integer point (ties toward +Infinity, Math.round semantics). */
export function roundPoint(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** Sign of the 2D cross product (b-a) x (c-a); exact for integer inputs. */
function orient(a: Point, b: Point, c: Point): number {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y) &&
    orient(a, b, p) === 0
  );
}

/** True when segments ab and cd intersect at all (touching endpoints included). */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

export interface EdgeHit {
  /** Index of the edge (vertex i -> vertex i+1) incident to the moved vertex. */
  movedEdge: number;
  /** Index of the other polygon edge it collides with. */
  otherEdge: number;
}

/**
 * Self-intersection check restricted to the two edges incident to vertex
 * `movedIndex` — the only edges a single-vertex move can affect. Returns the
 * first colliding edge pair, or null when the polygon stays simple.
 */
export function findSelfIntersection(vertices: Point[], movedIndex: number): EdgeHit | null {
  const n = vertices.length;
  if (n < 4) return null;
  const incident = [movedIndex, (movedIndex + n - 1) % n];
  for (const e of incident) {
    const a = vertices[e]!;
    const b = vertices[(e + 1) % n]!;
    for (let f = 0; f < n; f++) {
      if (f === e) continue;
      // Skip edges adjacent to e (they legitimately share an endpoint).
      if ((f + 1) % n === e || (e + 1) % n === f) continue;
      const c = vertices[f]!;
      const d = vertices[(f + 1) % n]!;
      if (segmentsIntersect(a, b, c, d)) {
        return { movedEdge: e, otherEdge: f };
      }
    }
  }
  return null;
}
