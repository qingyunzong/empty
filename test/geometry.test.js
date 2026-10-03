import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rat } from '../src/rational.js';
import { validatePolygon, pointPosition, classifyBox } from '../src/geometry.js';
import { mapInterval, parsePolynomial } from '../src/polynomial.js';

const V = (x, y) => ({ x: rat(x), y: rat(y) });
const poly = (pts) => validatePolygon(pts.map(([x, y]) => V(x, y)));
const box = (xmin, xmax, ymin, ymax) => ({
  xmin: rat(xmin), xmax: rat(xmax), ymin: rat(ymin), ymax: rat(ymax),
});

const POLYGONS = {
  3: [[0, 0], [6, 0], [0, 6]],
  4: [[0, 0], [6, 0], [6, 6], [0, 6]],
  5: [[0, 0], [6, 0], [6, 4], [4, 6], [0, 6]],
  6: [[1, 0], [5, 0], [6, 2], [5, 4], [1, 4], [0, 2]],
};

test('acceptance 1: n<=6 polygons, box corners enumerated with boundary relations', () => {
  for (const [n, verts] of Object.entries(POLYGONS)) {
    const p = poly(verts);
    assert.equal(p.vertices.length, Number(n));

    const inside = classifyBox(box('2', '3', '1', '2'), p);
    assert.equal(inside.classification, 'conforming', `n=${n} inside box`);
    assert.equal(inside.corners.length, 4);
    assert.ok(inside.corners.every((c) => c.position === 'inside'));

    const outside = classifyBox(box('20', '30', '20', '30'), p);
    assert.equal(outside.classification, 'nonconforming', `n=${n} disjoint box`);
    assert.ok(outside.corners.every((c) => c.position === 'outside'));

    const crossing = classifyBox(box('-1', '2', '1', '2'), p);
    assert.equal(crossing.classification, 'uncertain', `n=${n} crossing box`);
    const positions = crossing.corners.map((c) => c.position);
    assert.ok(positions.includes('outside') && positions.includes('inside'));
  }
});

test('acceptance 2: box exactly touching one polygon edge is conforming', () => {
  const p = poly(POLYGONS[4]);
  const r = classifyBox(box('0', '2', '1', '3'), p); // touches only edge x=0
  assert.equal(r.classification, 'conforming');
  assert.deepEqual(
    r.corners.map((c) => c.position),
    ['boundary', 'inside', 'inside', 'boundary'],
  );
});

test('box touching polygon from outside is uncertain, not nonconforming', () => {
  const p = poly(POLYGONS[4]);
  const r = classifyBox(box('-2', '0', '1', '3'), p); // shares edge x=0 segment
  assert.equal(r.classification, 'uncertain');
});

test('non-convex and degenerate polygons raise E_GEOMETRY', () => {
  const arrow = [[0, 0], [4, 0], [4, 4], [2, 2], [0, 4]]; // concave at (2,2)
  assert.throws(() => poly(arrow), (e) => e.code === 'E_GEOMETRY');
  const collinear = [[0, 0], [1, 1], [2, 2]];
  assert.throws(() => poly(collinear), (e) => e.code === 'E_GEOMETRY');
  assert.throws(() => poly([[0, 0], [1, 1]]), (e) => e.code === 'E_GEOMETRY');
});

test('pointPosition distinguishes inside, boundary, outside', () => {
  const p = poly(POLYGONS[4]);
  assert.equal(pointPosition(V('3', '3'), p), 'inside');
  assert.equal(pointPosition(V('0', '3'), p), 'boundary');
  assert.equal(pointPosition(V('7', '3'), p), 'outside');
});

test('quadratic stationary point is included only when inside the interval', () => {
  const quad = parsePolynomial(['3', '-2', '1']); // (t-1)^2 + 2
  const inside = mapInterval(quad, rat('1/2'), rat('3/2'));
  assert.equal(inside.stationary.t.toString(), '1');
  assert.equal(inside.stationary.value.toString(), '2');
  assert.equal(inside.min.toString(), '2');
  assert.equal(inside.max.toString(), '9/4');

  const outside = mapInterval(quad, rat('2'), rat('4')); // vertex t=1 outside
  assert.equal(outside.stationary, null);
  assert.equal(outside.min.toString(), '3');
  assert.equal(outside.max.toString(), '11');

  const linear = mapInterval(parsePolynomial(['1', '2']), rat('0'), rat('2'));
  assert.equal(linear.stationary, null);
  assert.equal(linear.min.toString(), '1');
  assert.equal(linear.max.toString(), '5');
});
