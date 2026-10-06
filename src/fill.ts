import {
  findSelfIntersections,
  ringContainment,
  ringDirection,
  signedArea2,
  type RingDirection,
  type SelfIntersection,
} from './geometry.js';
import { parsePath, type Point, type Subpath } from './path.js';

export type FillRule = 'evenodd' | 'nonzero';

/** Direction and containment evidence for a single ring (subpath). */
export interface RingEvidence {
  ringIndex: number;
  /** True when the subpath was explicitly closed with Z/z. */
  closed: boolean;
  /** True when the ring was open and got closed implicitly for filling. */
  implicitlyClosed: boolean;
  vertexCount: number;
  /** Doubled signed area; sign is the direction evidence. */
  signedArea2: number;
  direction: RingDirection;
  /** Winding number contribution at the query point. */
  winding: number;
  /** Rightward ray crossing count at the query point. */
  crossings: number;
  /** Query point lies exactly on a ring edge. */
  onBoundary: boolean;
  /** Per-ring containment verdicts under each rule. */
  contains: Record<FillRule, boolean>;
}

export interface RingSelfIntersections {
  ringIndex: number;
  intersections: SelfIntersection[];
}

export interface HitTestResult {
  point: Point;
  rule: FillRule;
  /** Final verdict under the requested rule. Boundary counts as inside. */
  inside: boolean;
  /** Query point lies on at least one ring edge. */
  onBoundary: boolean;
  /** Indices of rings that individually contain the point under the rule. */
  hits: number[];
  /** Per-ring direction and containment evidence. */
  rings: RingEvidence[];
  /** Edge-by-edge self-intersection findings per ring. */
  selfIntersections: RingSelfIntersections[];
  /** False when a ring exceeded the edge limit and was not checked. */
  selfIntersectionChecked: boolean;
}

export interface HitTestOptions {
  rule?: FillRule;
  /**
   * Maximum edge count for the O(n^2) reference self-intersection scan.
   * Rings above the limit are skipped. Defaults to 128.
   */
  selfIntersectionEdgeLimit?: number;
}

const DEFAULT_EDGE_LIMIT = 128;

/** Hit test integer (or any) query point against parsed subpaths. */
export function hitTest(
  subpaths: Subpath[],
  point: Point,
  options: HitTestOptions = {},
): HitTestResult {
  const rule = options.rule ?? 'nonzero';
  const edgeLimit = options.selfIntersectionEdgeLimit ?? DEFAULT_EDGE_LIMIT;

  const rings: RingEvidence[] = [];
  const selfIntersections: RingSelfIntersections[] = [];
  let selfIntersectionChecked = true;
  let totalWinding = 0;
  let totalCrossings = 0;
  let onBoundary = false;

  subpaths.forEach((subpath, ringIndex) => {
    const { winding, crossings, onBoundary: ringBoundary } = ringContainment(
      point,
      subpath.points,
    );
    totalWinding += winding;
    totalCrossings += crossings;
    onBoundary = onBoundary || ringBoundary;

    rings.push({
      ringIndex,
      closed: subpath.closed,
      implicitlyClosed: !subpath.closed,
      vertexCount: subpath.points.length,
      signedArea2: signedArea2(subpath.points),
      direction: ringDirection(subpath.points),
      winding,
      crossings,
      onBoundary: ringBoundary,
      contains: {
        nonzero: ringBoundary || winding !== 0,
        evenodd: ringBoundary || crossings % 2 === 1,
      },
    });

    const edgeCount = Math.max(subpath.points.length, 0);
    if (edgeCount <= edgeLimit) {
      const intersections = findSelfIntersections(subpath.points);
      if (intersections.length > 0) {
        selfIntersections.push({ ringIndex, intersections });
      }
    } else {
      selfIntersectionChecked = false;
    }
  });

  const inside =
    onBoundary || (rule === 'nonzero' ? totalWinding !== 0 : totalCrossings % 2 === 1);
  const hits = rings
    .filter((ring) => ring.contains[rule])
    .map((ring) => ring.ringIndex);

  return {
    point,
    rule,
    inside,
    onBoundary,
    hits,
    rings,
    selfIntersections,
    selfIntersectionChecked,
  };
}

/** Convenience: parse path data and hit test in one call. */
export function hitTestPath(
  d: string,
  x: number,
  y: number,
  options: HitTestOptions = {},
): HitTestResult {
  return hitTest(parsePath(d), { x, y }, options);
}
