import { cross3, onSegment, segmentsIntersect } from "./geometry.ts";
import type { Point } from "./geometry.ts";

export interface SelfIntersection {
  readonly edgeA: number;
  readonly edgeB: number;
  /** "proper" = edges cross in their interiors; "touch" = endpoint contact. */
  readonly type: "proper" | "touch";
  /** Intersection point (may be fractional for proper crossings). */
  readonly point: Point;
}

function intersectionPoint(a: Point, b: Point, c: Point, d: Point): Point {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denom = r.x * s.y - r.y * s.x;
  if (denom === 0) {
    // Collinear/parallel touch: report the shared endpoint if there is one.
    for (const p of [a, b]) if (onSegment(c, d, p)) return p;
    for (const p of [c, d]) if (onSegment(a, b, p)) return p;
    return a;
  }
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/**
 * Edge-by-edge O(n^2) self-intersection check for one closed ring (the
 * closing edge last->first is included). Adjacent edge pairs that share a
 * vertex are skipped. Intended as a reference verifier for short paths.
 */
export function findSelfIntersections(
  points: readonly Point[],
): SelfIntersection[] {
  const n = points.length;
  const results: SelfIntersection[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // adjacent
      const c = points[j]!;
      const d = points[(j + 1) % n]!;
      if (!segmentsIntersect(a, b, c, d)) continue;
      const proper =
        cross3(c, d, a) !== 0 && cross3(c, d, b) !== 0 &&
        cross3(a, b, c) !== 0 && cross3(a, b, d) !== 0;
      results.push({
        edgeA: i,
        edgeB: j,
        type: proper ? "proper" : "touch",
        point: intersectionPoint(a, b, c, d),
      });
    }
  }
  return results;
}
