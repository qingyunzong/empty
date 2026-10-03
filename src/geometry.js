import { Frac, F0, F1 } from './fraction.js';
import { ZoneError } from './errors.js';

export function parsePoint(v) {
  if (!v || typeof v !== 'object') throw new ZoneError('E_INPUT', 'point must be an object {x, y}');
  return { x: Frac.parse(v.x), y: Frac.parse(v.y) };
}

export const sub = (a, b) => ({ x: a.x.sub(b.x), y: a.y.sub(b.y) });
export const cross = (u, v) => u.x.mul(v.y).sub(u.y.mul(v.x));
export const dot = (u, v) => u.x.mul(v.x).add(u.y.mul(v.y));
export const dist2 = (a, b) => { const d = sub(a, b); return dot(d, d); };
export const pointToJSON = (p) => ({ x: p.x.toString(), y: p.y.toString() });

function orient(a, b, c) { return cross(sub(b, a), sub(c, a)).sign(); }

/** p on closed segment ab (collinearity included in the check). */
export function onSegment(a, b, p) {
  return cross(sub(b, a), sub(p, a)).isZero() && dot(sub(p, a), sub(p, b)).le(F0);
}

/** Exact intersection test for closed segments (handles collinear overlap). */
export function segmentsIntersect(p1, p2, p3, p4) {
  const o1 = orient(p1, p2, p3);
  const o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1);
  const o4 = orient(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, p3)) return true;
  if (o2 === 0 && onSegment(p1, p2, p4)) return true;
  if (o3 === 0 && onSegment(p3, p4, p1)) return true;
  if (o4 === 0 && onSegment(p3, p4, p2)) return true;
  return false;
}

/**
 * Validate a candidate vertex list as a convex polygon (collinear edges allowed).
 * Returns orientation (+1 CCW / -1 CW). Throws ZoneError E_EMPTY / E_GEOMETRY.
 */
export function validatePolygon(vs) {
  if (!Array.isArray(vs) || vs.length < 3) {
    throw new ZoneError('E_EMPTY', 'polygon needs at least 3 vertices');
  }
  const n = vs.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (vs[i].x.eq(vs[j].x) && vs[i].y.eq(vs[j].y)) {
        throw new ZoneError('E_GEOMETRY', `duplicate vertex at indices ${i} and ${j}`);
      }
    }
  }
  let pos = false, neg = false;
  for (let i = 0; i < n; i++) {
    const e1 = sub(vs[(i + 1) % n], vs[i]);
    const e2 = sub(vs[(i + 2) % n], vs[(i + 1) % n]);
    const c = cross(e1, e2).sign();
    if (c > 0) pos = true;
    else if (c < 0) neg = true;
    else if (dot(e1, e2).sign() < 0) {
      throw new ZoneError('E_GEOMETRY', `reversed collinear edge at vertex ${(i + 1) % n} (self-overlap)`);
    }
  }
  if (pos && neg) throw new ZoneError('E_GEOMETRY', 'polygon is not convex');
  if (!pos && !neg) throw new ZoneError('E_GEOMETRY', 'degenerate polygon (all vertices collinear)');
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ((i + 1) % n === j || (j + 1) % n === i) continue; // adjacent edges share a vertex
      if (segmentsIntersect(vs[i], vs[(i + 1) % n], vs[j], vs[(j + 1) % n])) {
        throw new ZoneError('E_GEOMETRY', `self-intersection between edges ${i} and ${j}`);
      }
    }
  }
  return pos ? 1 : -1;
}

/** Orientation (+1/-1) of an already-validated vertex list. */
export function orientationOf(vs) {
  const n = vs.length;
  for (let i = 0; i < n; i++) {
    const c = cross(sub(vs[(i + 1) % n], vs[i]), sub(vs[(i + 2) % n], vs[(i + 1) % n])).sign();
    if (c !== 0) return c;
  }
  return 1;
}

/** Squared distance from point p to closed segment ab, with projection parameter t on ab. */
export function pointSegDist2(p, a, b) {
  const d = sub(b, a);
  const dd = dot(d, d);
  if (dd.isZero()) return { d2: dist2(p, a), t: F0 };
  let t = dot(sub(p, a), d).div(dd);
  if (t.sign() < 0) t = F0;
  else if (t.gt(F1)) t = F1;
  const proj = { x: a.x.add(d.x.mul(t)), y: a.y.add(d.y.mul(t)) };
  return { d2: dist2(p, proj), t };
}

function paramOf(p, q, pt) {
  const d = sub(q, p);
  const dd = dot(d, d);
  if (dd.isZero()) return F0;
  return dot(sub(pt, p), d).div(dd);
}

function intersectionPoint(p1, p2, a, b) {
  const d1 = sub(p2, p1);
  const d2 = sub(b, a);
  const den = cross(d1, d2);
  if (!den.isZero()) {
    const t = cross(sub(a, p1), d2).div(den);
    return { x: p1.x.add(d1.x.mul(t)), y: p1.y.add(d1.y.mul(t)) };
  }
  for (const cand of [p1, p2]) if (onSegment(a, b, cand)) return cand;
  for (const cand of [a, b]) if (onSegment(p1, p2, cand)) return cand;
  return p1; // unreachable when segments intersect
}

/**
 * Exact squared distance between closed segments p1p2 and ab.
 * Returns { d2, t1, t2 }: t1 parameter on p1p2, t2 parameter on ab.
 */
export function segSegDist2(p1, p2, a, b) {
  if (segmentsIntersect(p1, p2, a, b)) {
    const pt = intersectionPoint(p1, p2, a, b);
    return { d2: F0, t1: paramOf(p1, p2, pt), t2: paramOf(a, b, pt) };
  }
  let best = null;
  const consider = (cand) => { if (!best || cand.d2.lt(best.d2)) best = cand; };
  let r = pointSegDist2(p1, a, b); consider({ d2: r.d2, t1: F0, t2: r.t });
  r = pointSegDist2(p2, a, b); consider({ d2: r.d2, t1: F1, t2: r.t });
  r = pointSegDist2(a, p1, p2); consider({ d2: r.d2, t1: r.t, t2: F0 });
  r = pointSegDist2(b, p1, p2); consider({ d2: r.d2, t1: r.t, t2: F1 });
  return best;
}
