import type { Point } from './path.js';

export interface Edge {
  a: Point;
  b: Point;
}

/** 2D cross product of vectors (a - o) x (b - o). Exact for safe integers. */
export function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * True when p lies on segment ab, inclusive of endpoints. Boundary counts
 * as inside for fill purposes, so this is the boundary oracle.
 */
export function onSegment(a: Point, b: Point, p: Point): boolean {
  if (cross(a, b, p) !== 0) return false;
  return (p.x - a.x) * (p.x - b.x) + (p.y - a.y) * (p.y - b.y) <= 0;
}

/**
 * Edges of a ring as filled: consecutive vertex pairs plus an implicit
 * closing edge from the last vertex back to the first. Open subpaths are
 * therefore closed implicitly, matching fill semantics. Zero-length
 * closing edges (last vertex equals first) are omitted.
 */
export function ringEdges(points: Point[]): Edge[] {
  const edges: Edge[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    edges.push({ a: points[i]!, b: points[i + 1]! });
  }
  if (points.length > 1) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    if (first.x !== last.x || first.y !== last.y) {
      edges.push({ a: last, b: first });
    }
  }
  return edges;
}

/**
 * Doubled signed area of the ring (implicitly closed). Positive means
 * counter-clockwise, negative clockwise, zero degenerate.
 */
export function signedArea2(points: Point[]): number {
  let sum = 0;
  for (const { a, b } of ringEdges(points)) {
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

export type RingDirection = 'ccw' | 'cw' | 'degenerate';

export function ringDirection(points: Point[]): RingDirection {
  const area = signedArea2(points);
  if (area > 0) return 'ccw';
  if (area < 0) return 'cw';
  return 'degenerate';
}

export interface RingContainment {
  /** Winding number of the ring around p (non-zero rule evidence). */
  winding: number;
  /** Ray crossings to the right of p (even-odd rule evidence). */
  crossings: number;
  /** True when p lies exactly on a ring edge (boundary counts as inside). */
  onBoundary: boolean;
}

/**
 * Winding number and crossing count of an implicitly closed ring around p,
 * computed in one edge sweep with a half-open y-interval convention so
 * vertices are never double counted. Boundary is detected exactly via
 * integer cross products before any crossing logic runs.
 */
export function ringContainment(p: Point, points: Point[]): RingContainment {
  let winding = 0;
  let crossings = 0;
  let onBoundary = false;
  for (const { a, b } of ringEdges(points)) {
    if (onSegment(a, b, p)) {
      onBoundary = true;
      continue;
    }
    const aBelow = a.y <= p.y;
    const bBelow = b.y <= p.y;
    if (aBelow === bBelow) continue;
    const side = cross(a, b, p);
    if (b.y > a.y) {
      // Upward crossing: counts when p is strictly left of the edge.
      if (side > 0) {
        winding += 1;
        crossings += 1;
      }
    } else {
      // Downward crossing: counts when p is strictly right of the edge.
      if (side < 0) {
        winding -= 1;
        crossings += 1;
      }
    }
  }
  return { winding, crossings, onBoundary };
}

/** Orientation sign of ordered triple (a, b, c). */
function orient(a: Point, b: Point, c: Point): number {
  return Math.sign(cross(a, b, c));
}

/** True when segments ab and cd intersect, including endpoint touches. */
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

export type IntersectionKind = 'cross' | 'touch' | 'overlap';

export interface SelfIntersection {
  /** Index of the first edge (into ringEdges order). */
  edgeA: number;
  /** Index of the second edge (into ringEdges order). */
  edgeB: number;
  kind: IntersectionKind;
}

function classify(a: Point, b: Point, c: Point, d: Point): IntersectionKind {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 === 0 && o2 === 0) return 'overlap';
  if (o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return 'cross';
  return 'touch';
}

/**
 * Reference O(n^2) edge-by-edge self-intersection check for short rings.
 * Adjacent edge pairs (which share a vertex by construction) are skipped.
 * Intended for small inputs; callers should gate it on an edge limit.
 */
export function findSelfIntersections(points: Point[]): SelfIntersection[] {
  const edges = ringEdges(points);
  const found: SelfIntersection[] = [];
  const n = edges.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) continue;
      const e1 = edges[i]!;
      const e2 = edges[j]!;
      if (segmentsIntersect(e1.a, e1.b, e2.a, e2.b)) {
        found.push({
          edgeA: i,
          edgeB: j,
          kind: classify(e1.a, e1.b, e2.a, e2.b),
        });
      }
    }
  }
  return found;
}
