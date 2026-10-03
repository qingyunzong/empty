import { Rat, ZERO, ONE } from './rational.js';
import { E, QError } from './errors.js';

/** 2D cross product (a - o) x (b - o) with exact rational arithmetic. */
export function cross(o, a, b) {
  return a.x.sub(o.x).mul(b.y.sub(o.y)).sub(a.y.sub(o.y).mul(b.x.sub(o.x)));
}

/**
 * Validate a convex polygon from ordered vertices [{x: Rat, y: Rat}, ...].
 * Collinear consecutive edges are allowed; all significant turns must share
 * one orientation. Throws QError(E_GEOMETRY) when non-convex or degenerate.
 */
export function validatePolygon(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) {
    throw new QError(E.GEOMETRY, 'tolerance polygon needs at least 3 vertices');
  }
  const n = vertices.length;
  let orientation = 0;
  for (let i = 0; i < n; i++) {
    const s = cross(vertices[i], vertices[(i + 1) % n], vertices[(i + 2) % n]).sign();
    if (s === 0) continue;
    if (orientation === 0) orientation = s;
    else if (s !== orientation) {
      throw new QError(E.GEOMETRY, 'tolerance polygon is not convex');
    }
  }
  if (orientation === 0) {
    throw new QError(E.GEOMETRY, 'tolerance polygon is degenerate (collinear vertices)');
  }
  return { vertices, orientation };
}

/** Position of a point relative to a convex polygon: 'inside' | 'boundary' | 'outside'. */
export function pointPosition(p, poly) {
  let boundary = false;
  const n = poly.vertices.length;
  for (let i = 0; i < n; i++) {
    const a = poly.vertices[i];
    const b = poly.vertices[(i + 1) % n];
    const s = cross(a, b, p).sign() * poly.orientation;
    if (s < 0) return 'outside';
    if (s === 0) boundary = true;
  }
  return boundary ? 'boundary' : 'inside';
}

export function boxCorners(box) {
  return [
    { x: box.xmin, y: box.ymin },
    { x: box.xmax, y: box.ymin },
    { x: box.xmax, y: box.ymax },
    { x: box.xmin, y: box.ymax },
  ];
}

/**
 * Classify an axis-aligned box against a convex polygon.
 *  - conforming:    every corner inside or on the boundary (box subset of polygon)
 *  - nonconforming: box and polygon are disjoint (separating axis exists)
 *  - uncertain:     otherwise (the box crosses the boundary)
 * Touching counts as intersecting, so a box merely touching the polygon from
 * outside is 'uncertain', while a box inside touching an edge is 'conforming'.
 */
export function classifyBox(box, poly) {
  const cornerPoints = boxCorners(box);
  const corners = cornerPoints.map((c) => ({ x: c.x, y: c.y, position: pointPosition(c, poly) }));
  if (corners.every((c) => c.position !== 'outside')) {
    return { classification: 'conforming', corners };
  }
  const axes = [[ONE, ZERO], [ZERO, ONE]];
  const n = poly.vertices.length;
  for (let i = 0; i < n; i++) {
    const a = poly.vertices[i];
    const b = poly.vertices[(i + 1) % n];
    const dx = b.x.sub(a.x);
    const dy = b.y.sub(a.y);
    if (dx.isZero() && dy.isZero()) continue;
    axes.push([dy.neg(), dx]);
  }
  for (const [ax, ay] of axes) {
    let pMin = null, pMax = null, bMin = null, bMax = null;
    for (const v of poly.vertices) {
      const d = ax.mul(v.x).add(ay.mul(v.y));
      if (pMin === null || d.cmp(pMin) < 0) pMin = d;
      if (pMax === null || d.cmp(pMax) > 0) pMax = d;
    }
    for (const c of cornerPoints) {
      const d = ax.mul(c.x).add(ay.mul(c.y));
      if (bMin === null || d.cmp(bMin) < 0) bMin = d;
      if (bMax === null || d.cmp(bMax) > 0) bMax = d;
    }
    if (bMax.cmp(pMin) < 0 || pMax.cmp(bMin) < 0) {
      return { classification: 'nonconforming', corners };
    }
  }
  return { classification: 'uncertain', corners };
}
