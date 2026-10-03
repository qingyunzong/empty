import { Rational } from './rational.js';
import { qerror } from './errors.js';

export function parsePoint(p) {
  if (!Array.isArray(p) || p.length !== 2) {
    throw qerror('E_GEOMETRY', `polygon vertex must be a [x, y] pair, got ${JSON.stringify(p)}`);
  }
  return { x: Rational.from(p[0]), y: Rational.from(p[1]) };
}

function sub(a, b) {
  return { x: a.x.sub(b.x), y: a.y.sub(b.y) };
}

function cross(u, v) {
  return u.x.mul(v.y).sub(u.y.mul(v.x));
}

// Validates strict ordering of a convex polygon: all consecutive turns must
// share one orientation (collinear vertices are tolerated, self-intersection
// and reflex turns are not).
export function assertConvexPolygon(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) {
    throw qerror('E_GEOMETRY', 'tolerance polygon needs at least 3 vertices');
  }
  const n = vertices.length;
  let orientation = 0;
  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    const c = vertices[(i + 2) % n];
    const s = cross(sub(b, a), sub(c, b)).sign();
    if (s === 0) continue;
    if (orientation === 0) {
      orientation = s;
    } else if (s !== orientation) {
      throw qerror('E_GEOMETRY', 'tolerance polygon is not convex');
    }
  }
  if (orientation === 0) {
    throw qerror('E_GEOMETRY', 'tolerance polygon is degenerate (all vertices collinear)');
  }
  return orientation;
}

// Inclusive point-in-convex-polygon test (boundary counts as inside).
export function pointInConvexPolygon(p, vertices) {
  const n = vertices.length;
  let orientation = 0;
  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    const s = cross(sub(b, a), sub(p, a)).sign();
    if (s === 0) continue;
    if (orientation === 0) {
      orientation = s;
    } else if (s !== orientation) {
      return false;
    }
  }
  return true;
}

function onSegment(a, b, p) {
  // p collinear with ab; check bounding box containment.
  return (
    p.x.ge(a.x.lt(b.x) ? a.x : b.x) &&
    p.x.le(a.x.lt(b.x) ? b.x : a.x) &&
    p.y.ge(a.y.lt(b.y) ? a.y : b.y) &&
    p.y.le(a.y.lt(b.y) ? b.y : a.y)
  );
}

// Exact segment-segment intersection, inclusive of endpoints and collinear overlap.
export function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross(sub(p4, p3), sub(p1, p3)).sign();
  const d2 = cross(sub(p4, p3), sub(p2, p3)).sign();
  const d3 = cross(sub(p2, p1), sub(p3, p1)).sign();
  const d4 = cross(sub(p2, p1), sub(p4, p1)).sign();
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

export function boxCorners(box) {
  const { x, y } = box;
  return [
    { x: x.lo, y: y.lo },
    { x: x.hi, y: y.lo },
    { x: x.hi, y: y.hi },
    { x: x.lo, y: y.hi },
  ];
}

function boxEdges(box) {
  const c = boxCorners(box);
  return [
    [c[0], c[1]],
    [c[1], c[2]],
    [c[2], c[3]],
    [c[3], c[0]],
  ];
}

function pointInBox(p, box) {
  return p.x.ge(box.x.lo) && p.x.le(box.x.hi) && p.y.ge(box.y.lo) && p.y.le(box.y.hi);
}

// Full exact analysis of an axis-aligned box against a convex polygon.
export function analyzeBox(box, vertices) {
  const corners = boxCorners(box).map((c) => ({
    x: c.x.toString(),
    y: c.y.toString(),
    inside: pointInConvexPolygon(c, vertices),
  }));
  const allCornersInside = corners.every((c) => c.inside);

  let intersects = allCornersInside;
  if (!intersects) {
    const n = vertices.length;
    const edges = boxEdges(box);
    outer: for (let i = 0; i < n; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % n];
      if (pointInBox(a, box)) {
        intersects = true;
        break;
      }
      for (const [e1, e2] of edges) {
        if (segmentsIntersect(e1, e2, a, b)) {
          intersects = true;
          break outer;
        }
      }
    }
  }

  return { corners, allCornersInside, intersects };
}

// conforming: whole box inside polygon (boundary included)
// nonconforming: box completely outside polygon (no shared point at all)
// uncertain: anything else (crosses or touches the boundary from outside)
export function classifyBox(box, vertices) {
  const { allCornersInside, intersects } = analyzeBox(box, vertices);
  if (allCornersInside) return 'conforming';
  if (!intersects) return 'nonconforming';
  return 'uncertain';
}
