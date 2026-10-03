import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafeZone } from '../src/zone.js';
import { Frac, F0, F1 } from '../src/fraction.js';
import { parsePoint, sub, dot, cross, segmentsIntersect, dist2 } from '../src/geometry.js';

// ---------- deterministic RNG ----------
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

// ---------- independent brute-force per-edge enumeration (acceptance 1) ----------
function brutePointSeg2(p, a, b) {
  const d = sub(b, a);
  const dd = dot(d, d);
  if (dd.isZero()) return dist2(p, a);
  let t = dot(sub(p, a), d).div(dd);
  if (t.sign() < 0) t = F0;
  else if (t.gt(F1)) t = F1;
  const proj = { x: a.x.add(d.x.mul(t)), y: a.y.add(d.y.mul(t)) };
  return dist2(p, proj);
}

function bruteMinGap2(vertices, p, q) {
  const n = vertices.length;
  let best = null;
  for (let i = 0; i < n; i++) {
    const a = vertices[i], b = vertices[(i + 1) % n];
    let d2;
    if (segmentsIntersect(p, q, a, b)) {
      d2 = F0;
    } else {
      d2 = brutePointSeg2(p, a, b);
      for (const c of [brutePointSeg2(q, a, b), brutePointSeg2(a, p, q), brutePointSeg2(b, p, q)]) {
        if (c.lt(d2)) d2 = c;
      }
    }
    if (!best || d2.lt(best)) best = d2;
  }
  return best;
}

// ---------- random convex polygon with n in [3,6] via monotone chain ----------
function convexHull(pts) {
  const sorted = pts.slice().sort((u, v) => (u.x < v.x ? -1 : u.x > v.x ? 1 : u.y < v.y ? -1 : u.y > v.y ? 1 : 0));
  const uniq = sorted.filter((p, i) => i === 0 || p.x !== sorted[i - 1].x || p.y !== sorted[i - 1].y);
  if (uniq.length < 3) return [];
  const crossO = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of uniq) {
    while (lower.length >= 2 && crossO(lower[lower.length - 2], lower[lower.length - 1], p) <= 0n) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of uniq.slice().reverse()) {
    while (upper.length >= 2 && crossO(upper[upper.length - 2], upper[upper.length - 1], p) <= 0n) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function randomPolygon(rng) {
  for (;;) {
    const m = 6 + Math.floor(rng() * 8);
    const pts = [];
    for (let i = 0; i < m; i++) pts.push({ x: BigInt(Math.floor(rng() * 24) - 12), y: BigInt(Math.floor(rng() * 24) - 12) });
    const hull = convexHull(pts);
    if (hull.length >= 3 && hull.length <= 6) return hull.map((p) => ({ x: p.x.toString(), y: p.y.toString() }));
  }
}

function randomPoint(rng) {
  // rationals with denominator 1 or 2 to exercise fractions
  const num = Math.floor(rng() * 40) - 20;
  const den = rng() < 0.5 ? 1 : 2;
  return den === 1 ? String(num) : `${num}/${den}`;
}

test('acceptance 1: n<=6 polygons, minGapSquared matches brute-force per-edge enumeration', () => {
  const rng = lcg(20261003);
  for (let iter = 0; iter < 60; iter++) {
    const vertices = randomPolygon(rng);
    const zone = new SafeZone(vertices);
    for (let s = 0; s < 8; s++) {
      const seg = {
        p: { x: randomPoint(rng), y: randomPoint(rng) },
        q: { x: randomPoint(rng), y: randomPoint(rng) },
      };
      const res = zone.query(seg);
      const vs = vertices.map(parsePoint);
      const expected = bruteMinGap2(vs, parsePoint(seg.p), parsePoint(seg.q));
      assert.equal(
        res.minGapSquared, expected.toString(),
        `iter ${iter} seg ${s}: ${JSON.stringify({ vertices, seg, res })}`,
      );
      // certificate consistency: reported min equals min of per-edge gaps
      const cert = res.certificate;
      assert.equal(cert.allEdgeGapsSquared.length, vertices.length);
      const minOfList = cert.allEdgeGapsSquared.map(Frac.parse).reduce((a, b) => (b.lt(a) ? b : a));
      assert.equal(cert.minGapSquared, minOfList.toString());
      assert.equal(cert.allEdgeGapsSquared[res.nearestEdge], cert.minGapSquared);
      // projection points reproduce the gap and lie on the respective segments
      const ps = parsePoint(cert.pointOnSegment);
      const pe = parsePoint(cert.pointOnEdge);
      assert.equal(dist2(ps, pe).toString(), cert.minGapSquared);
      const t1 = Frac.parse(cert.segmentParam);
      const t2 = Frac.parse(cert.edgeParam);
      assert.ok(t1.ge(F0) && t1.le(F1), 'segmentParam in [0,1]');
      assert.ok(t2.ge(F0) && t2.le(F1), 'edgeParam in [0,1]');
      const p0 = parsePoint(seg.p), p1 = parsePoint(seg.q);
      const dq = sub(p1, p0);
      assert.equal(ps.x.toString(), p0.x.add(dq.x.mul(t1)).toString());
      assert.equal(ps.y.toString(), p0.y.add(dq.y.mul(t1)).toString());
      const ea = parsePoint(cert.edge.a), eb = parsePoint(cert.edge.b);
      const de = sub(eb, ea);
      assert.equal(pe.x.toString(), ea.x.add(de.x.mul(t2)).toString());
      assert.equal(pe.y.toString(), ea.y.add(de.y.mul(t2)).toString());
    }
  }
});

test('acceptance 2: segment goes from inside to touching across two adjacent versions', () => {
  const zone = new SafeZone([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]);
  const seg = { p: { x: 1, y: 1 }, q: { x: 2, y: 2 } };
  const before = zone.query(seg);
  assert.equal(before.classification, 'inside');
  assert.equal(before.minGapSquared, '1');
  // adjacent version: move vertex (4,4) to (2,2); segment endpoint now lies on the boundary
  zone.updateVertex(2, { x: 2, y: 2 });
  const after = zone.query(seg);
  assert.equal(after.classification, 'touching');
  assert.equal(after.minGapSquared, '0');
  // undo restores the inside classification
  zone.undo();
  const restored = zone.query(seg);
  assert.equal(restored.classification, 'inside');
  assert.equal(restored.minGapSquared, '1');
});

test('acceptance 3: illegal vertex transaction rolls back, undo info unchanged', () => {
  const zone = new SafeZone([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]);
  zone.updateVertex(1, { x: 5, y: 0 }); // one legal commit so undo stack is non-empty
  const stateBefore = zone.state();
  // non-convex attempt
  assert.throws(() => zone.updateVertex(1, { x: 2, y: 3 }), (e) => e.code === 'E_GEOMETRY');
  // duplicate-point attempt
  assert.throws(() => zone.updateVertex(1, { x: 4, y: 4 }), (e) => e.code === 'E_GEOMETRY');
  // addVertex producing duplicate
  assert.throws(() => zone.addVertex(0, { x: 0, y: 0 }), (e) => e.code === 'E_GEOMETRY');
  // removeVertex below minimum (on a fresh triangle zone)
  const tri = new SafeZone([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }]);
  assert.throws(() => tri.removeVertex(0), (e) => e.code === 'E_EMPTY');
  assert.equal(tri.state().vertexCount, 3);
  assert.equal(tri.state().undoDepth, 0);
  const stateAfter = zone.state();
  assert.deepEqual(stateAfter, stateBefore); // vertices + undo/redo depths untouched
  // undo still restores the state from before the legal commit
  const u = zone.undo();
  assert.equal(u.changed, true);
  assert.deepEqual(zone.state().vertices, [
    { x: '0', y: '0' }, { x: '4', y: '0' }, { x: '4', y: '4' }, { x: '0', y: '4' },
  ]);
});

test('acceptance 4: degenerate zero-length segment reports correct inside/outside status', () => {
  const zone = new SafeZone([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]);
  const inside = zone.query({ p: { x: 1, y: 1 }, q: { x: 1, y: 1 } });
  assert.equal(inside.classification, 'inside');
  assert.equal(inside.minGapSquared, '1');
  const outside = zone.query({ p: { x: 5, y: 1 }, q: { x: 5, y: 1 } });
  assert.equal(outside.classification, 'outside');
  assert.equal(outside.minGapSquared, '1');
  const onBoundary = zone.query({ p: { x: 0, y: 2 }, q: { x: 0, y: 2 } });
  assert.equal(onBoundary.classification, 'touching');
  assert.equal(onBoundary.minGapSquared, '0');
  const onVertex = zone.query({ p: { x: 4, y: 4 }, q: { x: 4, y: 4 } });
  assert.equal(onVertex.classification, 'touching');
  assert.equal(onVertex.minGapSquared, '0');
});

test('collinear edges allowed; rational coordinates throughout', () => {
  const zone = new SafeZone([
    { x: 0, y: 0 }, { x: '3/2', y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 },
  ]);
  const r = zone.query({ p: { x: '1/2', y: '1/2' }, q: { x: '5/2', y: '1/2' } });
  assert.equal(r.classification, 'inside');
  assert.equal(r.minGapSquared, '1/4');
});
