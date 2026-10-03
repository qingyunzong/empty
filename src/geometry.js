import { Fraction, ZERO, ONE } from './fraction.js';
import { fail } from './errors.js';

export function point(x, y) {
  return { x: Fraction.from(x), y: Fraction.from(y) };
}

export function pointsEqual(a, b) {
  return a.x.eq(b.x) && a.y.eq(b.y);
}

export function vecSub(a, b) {
  return { x: a.x.sub(b.x), y: a.y.sub(b.y) };
}

export function vecAdd(a, b) {
  return { x: a.x.add(b.x), y: a.y.add(b.y) };
}

export function vecScale(a, t) {
  return { x: a.x.mul(t), y: a.y.mul(t) };
}

export function cross(u, v) {
  return u.x.mul(v.y).sub(u.y.mul(v.x));
}

export function dot(u, v) {
  return u.x.mul(v.x).add(u.y.mul(v.y));
}

export function orient(a, b, c) {
  return cross(vecSub(b, a), vecSub(c, a));
}

export function dist2(a, b) {
  const d = vecSub(a, b);
  return dot(d, d);
}

export function pointOnSegment(p, a, b) {
  if (orient(a, b, p).sign() !== 0) return false;
  return dot(vecSub(p, a), vecSub(p, b)).sign() <= 0;
}

function rangesOverlap(a, b, c, d) {
  const lo1 = a.le(b) ? a : b;
  const hi1 = a.le(b) ? b : a;
  const lo2 = c.le(d) ? c : d;
  const hi2 = c.le(d) ? d : c;
  return lo1.le(hi2) && lo2.le(hi1);
}

export function segmentsIntersect(a, b, c, d) {
  const abPoint = pointsEqual(a, b);
  const cdPoint = pointsEqual(c, d);
  if (abPoint && cdPoint) return pointsEqual(a, c);
  if (abPoint) return pointOnSegment(a, c, d);
  if (cdPoint) return pointOnSegment(c, a, b);
  const o1 = orient(a, b, c).sign();
  const o2 = orient(a, b, d).sign();
  const o3 = orient(c, d, a).sign();
  const o4 = orient(c, d, b).sign();
  if (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0) {
    return rangesOverlap(a.x, b.x, c.x, d.x) && rangesOverlap(a.y, b.y, c.y, d.y);
  }
  return o1 * o2 <= 0 && o3 * o4 <= 0;
}

/**
 * Parameter t in [0,1] of point p projected onto segment a-b (p assumed on the line).
 */
export function paramOn(a, b, p) {
  const ab = vecSub(b, a);
  const l2 = dot(ab, ab);
  if (l2.isZero()) return ZERO;
  return dot(vecSub(p, a), ab).div(l2);
}

function intersectionPoint(a, b, c, d) {
  if (pointsEqual(a, b)) return a;
  if (pointsEqual(c, d)) return c;
  const ab = vecSub(b, a);
  const cd = vecSub(d, c);
  const denom = cross(ab, cd);
  if (denom.isZero()) {
    // Collinear overlap (or shared endpoint): find an endpoint on the other segment.
    if (pointOnSegment(a, c, d)) return a;
    if (pointOnSegment(b, c, d)) return b;
    if (pointOnSegment(c, a, b)) return c;
    return d;
  }
  const t = cross(vecSub(c, a), cd).div(denom);
  return vecAdd(a, vecScale(ab, t));
}

/**
 * Squared distance from point p to segment a-b, with exact projection parameter.
 */
export function pointSegmentDistance2(p, a, b) {
  const ab = vecSub(b, a);
  const l2 = dot(ab, ab);
  if (l2.isZero()) {
    return { d2: dist2(p, a), t: ZERO, closest: a };
  }
  let t = dot(vecSub(p, a), ab).div(l2);
  if (t.sign() < 0) t = ZERO;
  else if (t.gt(ONE)) t = ONE;
  const closest = vecAdd(a, vecScale(ab, t));
  return { d2: dist2(p, closest), t, closest };
}

/**
 * Exact squared distance between segments a-b and c-d, plus the two
 * projection points and their parameters (fractions, no floats).
 */
export function segmentSegmentDistance2(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) {
    const p = intersectionPoint(a, b, c, d);
    return {
      d2: ZERO,
      pOnAB: p,
      pOnCD: p,
      tAB: paramOn(a, b, p),
      tCD: paramOn(c, d, p),
    };
  }
  const candidates = [];
  const r1 = pointSegmentDistance2(a, c, d);
  candidates.push({ d2: r1.d2, pOnAB: a, pOnCD: r1.closest, tAB: ZERO, tCD: r1.t });
  const r2 = pointSegmentDistance2(b, c, d);
  candidates.push({ d2: r2.d2, pOnAB: b, pOnCD: r2.closest, tAB: ONE, tCD: r2.t });
  const r3 = pointSegmentDistance2(c, a, b);
  candidates.push({ d2: r3.d2, pOnAB: r3.closest, pOnCD: c, tAB: r3.t, tCD: ZERO });
  const r4 = pointSegmentDistance2(d, a, b);
  candidates.push({ d2: r4.d2, pOnAB: r4.closest, pOnCD: d, tAB: r4.t, tCD: ONE });
  let best = candidates[0];
  for (const cand of candidates) {
    if (cand.d2.lt(best.d2)) best = cand;
  }
  return best;
}

/**
 * Validate a convex polygon (collinear edges allowed).
 * Returns { ok: true, orientation: 1 | -1 } or { ok: false, error }.
 */
export function validatePolygon(vertices) {
  const n = vertices.length;
  if (n < 3) {
    return fail('E_EMPTY', `polygon needs at least 3 vertices, got ${n}`);
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (pointsEqual(vertices[i], vertices[j])) {
        return fail('E_GEOMETRY', `duplicate vertex at indices ${i} and ${j}`);
      }
    }
  }
  let orientation = 0;
  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    const c = vertices[(i + 2) % n];
    const s = orient(a, b, c).sign();
    if (s !== 0) {
      if (orientation === 0) orientation = s;
      else if (s !== orientation) {
        return fail('E_GEOMETRY', `non-convex turn at vertex ${(i + 1) % n}`);
      }
    } else {
      // Collinear consecutive edges are allowed only if they keep direction;
      // a 180-degree reversal overlaps the previous edge (self-intersection).
      const e1 = vecSub(b, a);
      const e2 = vecSub(c, b);
      if (dot(e1, e2).sign() < 0) {
        return fail('E_GEOMETRY', `edge reverses direction at vertex ${(i + 1) % n} (self-intersection)`);
      }
    }
  }
  if (orientation === 0) {
    return fail('E_GEOMETRY', 'degenerate polygon: all vertices are collinear');
  }
  // Non-adjacent edge pairs must not touch or cross.
  for (let i = 0; i < n; i++) {
    const a1 = vertices[i];
    const a2 = vertices[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1) continue;
      if (i === 0 && j === n - 1) continue;
      const b1 = vertices[j];
      const b2 = vertices[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) {
        return fail('E_GEOMETRY', `edges ${i} and ${j} intersect (self-intersection)`);
      }
    }
  }
  return { ok: true, orientation };
}

/**
 * Classify a point against a validated convex polygon.
 * orientation: +1 for CCW, -1 for CW.
 */
export function classifyPoint(vertices, orientation, p) {
  let onBoundary = false;
  const signs = [];
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const s = orient(a, b, p).sign() * orientation;
    signs.push(s);
    if (s < 0) return { classification: 'outside', edgeSigns: signs };
    if (s === 0) onBoundary = true;
  }
  return { classification: onBoundary ? 'boundary' : 'inside', edgeSigns: signs };
}
