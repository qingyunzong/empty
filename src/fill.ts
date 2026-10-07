import { cross3, onSegment, signedArea2 } from "./geometry.ts";
import type { Point } from "./geometry.ts";
import type { Subpath } from "./path.ts";

export type FillRule = "evenodd" | "nonzero";

/** One ray-crossing of the horizontal ray shot to +x from the query point. */
export interface Crossing {
  readonly edgeIndex: number;
  readonly from: Point;
  readonly to: Point;
  /** "up" = edge crosses the ray going upward, "down" = going downward. */
  readonly direction: "up" | "down";
  /** Winding contribution: +1 for upward crossings, -1 for downward. */
  readonly delta: 1 | -1;
}

export interface RingEvidence {
  readonly ringIndex: number;
  readonly points: readonly Point[];
  /** True when the ring was open and the closing edge was implied by the fill. */
  readonly implicitlyClosed: boolean;
  readonly signedArea2: number;
  readonly orientation: "ccw" | "cw" | "degenerate";
  readonly winding: number;
  readonly crossings: readonly Crossing[];
  readonly onBoundary: boolean;
  /** Index of the edge the point lies on, or null. */
  readonly boundaryEdge: number | null;
  /** Whether this ring alone contains the point under the active rule. */
  readonly contains: boolean;
}

export interface FillResult {
  readonly rule: FillRule;
  readonly point: Point;
  readonly inside: boolean;
  readonly onBoundary: boolean;
  /** Total winding number across all rings (nonzero-rule evidence). */
  readonly winding: number;
  /** Total ray crossings across all rings (even-odd parity evidence). */
  readonly crossingCount: number;
  /** Rings that individually contain the point. */
  readonly hits: readonly RingEvidence[];
  /** Evidence for every ring, hit or not. */
  readonly rings: readonly RingEvidence[];
}

function ringEdges(points: readonly Point[]): Array<[Point, Point]> {
  const edges: Array<[Point, Point]> = [];
  for (let i = 0; i < points.length; i++) {
    edges.push([points[i]!, points[(i + 1) % points.length]!]);
  }
  return edges;
}

function classifyRing(
  ringIndex: number,
  sub: Subpath,
  p: Point,
  rule: FillRule,
): RingEvidence {
  const pts = sub.points;
  const crossings: Crossing[] = [];
  let winding = 0;
  let onBoundary = false;
  let boundaryEdge: number | null = null;

  ringEdges(pts).forEach(([a, b], edgeIndex) => {
    if (onSegment(a, b, p)) {
      onBoundary = true;
      boundaryEdge = edgeIndex;
      return;
    }
    if (a.y <= p.y) {
      if (b.y > p.y && cross3(a, b, p) > 0) {
        crossings.push({ edgeIndex, from: a, to: b, direction: "up", delta: 1 });
        winding += 1;
      }
    } else if (b.y <= p.y && cross3(a, b, p) < 0) {
      crossings.push({ edgeIndex, from: a, to: b, direction: "down", delta: -1 });
      winding -= 1;
    }
  });

  const area2 = signedArea2(pts);
  const contains =
    onBoundary ||
    (rule === "evenodd" ? crossings.length % 2 === 1 : winding !== 0);

  return {
    ringIndex,
    points: pts,
    implicitlyClosed: !sub.closed,
    signedArea2: area2,
    orientation: area2 > 0 ? "ccw" : area2 < 0 ? "cw" : "degenerate",
    winding,
    crossings,
    onBoundary,
    boundaryEdge,
    contains,
  };
}

/**
 * Test an integer point against the filled region of the given subpaths.
 * Boundary counts as inside; open subpaths are implicitly closed for filling.
 * Returns per-ring hit evidence including winding direction and crossings.
 */
export function containsPoint(
  subpaths: readonly Subpath[],
  point: Point,
  rule: FillRule,
): FillResult {
  const rings = subpaths.map((sub, i) => classifyRing(i, sub, point, rule));
  const onBoundary = rings.some((r) => r.onBoundary);
  const winding = rings.reduce((acc, r) => acc + r.winding, 0);
  const crossingCount = rings.reduce((acc, r) => acc + r.crossings.length, 0);
  const inside =
    onBoundary ||
    (rule === "evenodd" ? crossingCount % 2 === 1 : winding !== 0);
  return {
    rule,
    point,
    inside,
    onBoundary,
    winding,
    crossingCount,
    hits: rings.filter((r) => r.contains),
    rings,
  };
}
