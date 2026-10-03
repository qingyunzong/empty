import test from 'node:test';
import assert from 'node:assert/strict';
import { Fraction, ZERO, ONE } from '../src/fraction.js';
import { SafeZone } from '../src/safezone.js';
import { point, dist2 } from '../src/geometry.js';

// ---------- Independent brute-force reference (acceptance 1) ----------
// Deliberately re-implemented here from first principles: for every edge,
// squared distance between the query segment and the edge segment, then min.

function f(v) {
  return Fraction.from(v);
}

function sub(a, b) {
  return { x: f(a.x).sub(f(b.x)), y: f(a.y).sub(f(b.y)) };
}

function dot(u, v) {
  return f(u.x).mul(f(v.x)).add(f(u.y).mul(f(v.y)));
}

function cross(u, v) {
  return f(u.x).mul(f(v.y)).sub(f(u.y).mul(f(v.x)));
}

function d2(a, b) {
  return dot(sub(a, b), sub(a, b));
}

function orient(a, b, c) {
  return cross(sub(b, a), sub(c, a)).sign();
}

function brutePointSeg2(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2.isZero()) return d2(p, a);
  let t = dot(sub(p, a), ab).div(l2);
  if (t.sign() < 0) t = ZERO;
  if (t.cmp(ONE) > 0) t = ONE;
  const q = { x: f(a.x).add(ab.x.mul(t)), y: f(a.y).add(ab.y.mul(t)) };
  return d2(p, q);
}

function bruteSegSeg2(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  const collinear = o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0;
  if (!collinear && o1 * o2 <= 0 && o3 * o4 <= 0) return ZERO;
  if (collinear) {
    const on = (p, u, v) =>
      orient(u, v, p) === 0 && dot(sub(p, u), sub(p, v)).sign() <= 0;
    if (on(a, c, d) || on(b, c, d) || on(c, a, b) || on(d, a, b)) return ZERO;
  }
  let best = brutePointSeg2(a, c, d);
  for (const cand of [
    brutePointSeg2(b, c, d),
    brutePointSeg2(c, a, b),
    brutePointSeg2(d, a, b),
  ]) {
    if (cand.lt(best)) best = cand;
  }
  return best;
}

function bruteMinGap2(vertices, a, b) {
  let best = null;
  for (let i = 0; i < vertices.length; i++) {
    const c = vertices[i];
    const dd = vertices[(i + 1) % vertices.length];
    const g = bruteSegSeg2(a, b, c, dd);
    if (best === null || g.lt(best)) best = g;
  }
  return best;
}

// ---------- Fixtures: convex polygons with n = 3..6, rational coords ----------

const POLYGONS = {
  triangle: [[0, 0], [6, 0], [0, 4]],
  quad: [[0, 0], [4, 0], [4, 4], [0, 4]],
  pentagon: [[0, 0], [5, 0], [6, 3], [3, 6], [0, 4]],
  hexagon: [[0, 0], [3, 0], [5, 2], [5, 5], [2, 6], [0, 4]],
  collinearQuad: [[0, 0], [2, 0], [4, 0], [4, 3], [0, 3]], // collinear edge allowed
  rationalTri: [[0, 0], ['5/2', 0], [0, '7/3']],
};

const SEGMENTS = [
  [[1, 1], [2, 1]],
  [[1, 1], [3, 3]],
  [['1/3', '1/2'], ['5/2', '3/4']],
  [[-1, -1], [1, 1]],   // pokes out
  [[10, 10], [12, 9]],  // fully outside
  [[0, 1], [2, 1]],     // endpoint on boundary
  [[2, 2], [2, 2]],     // degenerate point
];

test('acceptance 1: gapSquared matches brute-force per-edge enumeration (n<=6)', () => {
  for (const [name, verts] of Object.entries(POLYGONS)) {
    const zone = new SafeZone(verts);
    for (const [a, b] of SEGMENTS) {
      const r = zone.analyzeSegment(a, b);
      assert.equal(r.ok, true, `${name} ${JSON.stringify([a, b])}`);
      const pa = point(a[0], a[1]);
      const pb = point(b[0], b[1]);
      const pv = verts.map(([x, y]) => point(x, y));
      const expected = bruteMinGap2(pv, pa, pb);
      assert.equal(
        r.gapSquared.toString(),
        expected.toString(),
        `${name} segment ${JSON.stringify([a, b])}`
      );
      // Certificate: per-edge enumeration is present and consistent.
      assert.equal(r.certificate.edges.length, verts.length);
      for (const e of r.certificate.edges) {
        const brute = bruteSegSeg2(pa, pb, pv[e.index], pv[(e.index + 1) % pv.length]);
        assert.equal(e.gapSquared.toString(), brute.toString(), `edge ${e.index}`);
      }
      assert.equal(r.certificate.checks.allGapsNonNegative, true);
      assert.equal(r.certificate.checks.minIsMinimal, true);
      assert.equal(r.certificate.checks.projectionConsistent, true);
      // Projection points realize the reported gap and lie on the segments.
      assert.ok(dist2(r.pointOnSegment, r.pointOnEdge).eq(r.gapSquared));
      assert.ok(r.tSegment.ge(ZERO) && r.tSegment.le(ONE));
      assert.ok(r.tEdge.ge(ZERO) && r.tEdge.le(ONE));
    }
  }
});

test('exact fraction: distance to hypotenuse is 1/18 with t = 1/2', () => {
  const zone = new SafeZone([[0, 0], [1, 0], [0, 1]]);
  const r = zone.analyzeSegment(['1/3', '1/3'], ['1/3', '1/3']);
  assert.equal(r.status, 'inside');
  assert.equal(r.gapSquared.toString(), '1/18');
  assert.equal(r.nearestEdge.index, 1);
  assert.equal(r.pointOnEdge.x.toString(), '1/2');
  assert.equal(r.pointOnEdge.y.toString(), '1/2');
  assert.equal(r.tEdge.toString(), '1/2');
  assert.equal(r.pointOnSegment.x.toString(), '1/3');
});

test('acceptance 2: segment goes from inside to touching across two versions', () => {
  const zone = new SafeZone([[0, 0], [4, 0], [4, 4], [0, 4]]);
  const seg = [[1, 1], [3, 3]];

  const v1 = zone.analyzeSegment(seg[0], seg[1]);
  assert.equal(v1.status, 'inside');
  assert.ok(v1.gapSquared.gt(ZERO));

  // Move vertex (4,4) onto the segment endpoint (3,3): still convex.
  const commit = zone.updateVertex(2, [3, 3]);
  assert.equal(commit.ok, true);

  const v2 = zone.analyzeSegment(seg[0], seg[1]);
  assert.equal(v2.status, 'touching');
  assert.ok(v2.gapSquared.isZero());
  assert.equal(v2.pointOnSegment.x.toString(), '3');
  assert.equal(v2.pointOnSegment.y.toString(), '3');

  // Undo restores the inside state.
  assert.equal(zone.undo().ok, true);
  const v1again = zone.analyzeSegment(seg[0], seg[1]);
  assert.equal(v1again.status, 'inside');
  assert.ok(v1again.gapSquared.gt(ZERO));
});

test('endpoint-only contact is touching, not crossing out', () => {
  const zone = new SafeZone([[0, 0], [4, 0], [4, 4], [0, 4]]);
  const r = zone.analyzeSegment([4, 2], [2, 2]); // one endpoint on the boundary
  assert.equal(r.status, 'touching');
  assert.ok(r.gapSquared.isZero());
  const r2 = zone.analyzeSegment([0, 0], [4, 4]); // diagonal, both endpoints corners
  assert.equal(r2.status, 'touching');
  assert.ok(r2.gapSquared.isZero());
});

test('segment lying on an edge has gap 0 and touching status', () => {
  const zone = new SafeZone([[0, 0], [4, 0], [4, 4], [0, 4]]);
  const r = zone.analyzeSegment([1, 0], [3, 0]);
  assert.equal(r.status, 'touching');
  assert.equal(r.gapSquared.toString(), '0');
});

test('crossing segment reports outside with zero gap; far segment reports outside with positive gap', () => {
  const zone = new SafeZone([[0, 0], [4, 0], [4, 4], [0, 4]]);
  const through = zone.analyzeSegment([-1, 2], [5, 2]);
  assert.equal(through.status, 'outside');
  assert.ok(through.gapSquared.isZero()); // intersects the boundary
  const far = zone.analyzeSegment([10, 10], [12, 10]);
  assert.equal(far.status, 'outside');
  assert.ok(far.gapSquared.gt(ZERO));
});

test('acceptance 4: degenerate zero-length segment gives correct in/out status', () => {
  const zone = new SafeZone([[0, 0], [4, 0], [4, 4], [0, 4]]);

  const inside = zone.analyzeSegment([2, 2], [2, 2]);
  assert.equal(inside.degenerate, true);
  assert.equal(inside.status, 'inside');
  assert.equal(inside.gapSquared.toString(), '4'); // distance 2 to each edge

  const outside = zone.analyzeSegment([5, 5], [5, 5]);
  assert.equal(outside.degenerate, true);
  assert.equal(outside.status, 'outside');
  assert.equal(outside.gapSquared.toString(), '2'); // nearest corner (4,4)

  const onEdge = zone.analyzeSegment([4, 2], [4, 2]);
  assert.equal(onEdge.degenerate, true);
  assert.equal(onEdge.status, 'touching');
  assert.ok(onEdge.gapSquared.isZero());

  const rational = zone.analyzeSegment(['1/2', '1/2'], ['1/2', '1/2']);
  assert.equal(rational.status, 'inside');
  assert.equal(rational.gapSquared.toString(), '1/4');
});

test('certificate endpoints carry per-edge sign witnesses', () => {
  const zone = new SafeZone([[0, 0], [4, 0], [4, 4], [0, 4]]);
  const r = zone.analyzeSegment([2, 2], [9, 9]);
  assert.equal(r.status, 'outside');
  assert.deepEqual(r.certificate.endpoints[0].edgeSigns, [1, 1, 1, 1]);
  assert.equal(r.certificate.endpoints[0].classification, 'inside');
  assert.equal(r.certificate.endpoints[1].classification, 'outside');
  assert.ok(r.certificate.endpoints[1].edgeSigns.every((s) => s === 1 || s === 0 || s === -1));
});
