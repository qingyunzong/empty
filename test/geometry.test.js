import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePoint,
  assertConvexPolygon,
  pointInConvexPolygon,
  classifyBox,
  analyzeBox,
} from '../src/geometry.js';
import { Interval } from '../src/interval.js';
import { Rational } from '../src/rational.js';

const SQUARE = [
  ['0', '0'],
  ['10', '0'],
  ['10', '10'],
  ['0', '10'],
].map(parsePoint);

function box(x0, x1, y0, y1) {
  return { x: new Interval(x0, x1), y: new Interval(y0, y1) };
}

test('non-convex polygon raises E_GEOMETRY', () => {
  const concave = [
    ['0', '0'],
    ['10', '0'],
    ['10', '10'],
    ['5', '3'],
    ['0', '10'],
  ].map(parsePoint);
  assert.throws(() => assertConvexPolygon(concave), (e) => e.code === 'E_GEOMETRY');
});

test('degenerate and tiny polygons raise E_GEOMETRY', () => {
  const line = [['0', '0'], ['1', '1'], ['2', '2']].map(parsePoint);
  assert.throws(() => assertConvexPolygon(line), (e) => e.code === 'E_GEOMETRY');
  assert.throws(() => assertConvexPolygon([['0', '0'], ['1', '1']].map(parsePoint)), (e) => e.code === 'E_GEOMETRY');
});

test('point in convex polygon includes boundary', () => {
  const inside = { x: Rational.from('5'), y: Rational.from('5') };
  const onEdge = { x: Rational.from('0'), y: Rational.from('5') };
  const outside = { x: Rational.from('-1/2'), y: Rational.from('5') };
  assert.equal(pointInConvexPolygon(inside, SQUARE), true);
  assert.equal(pointInConvexPolygon(onEdge, SQUARE), true);
  assert.equal(pointInConvexPolygon(outside, SQUARE), false);
});

test('acceptance 1: corner enumeration and boundary relations for n=3..6 polygons', () => {
  const polygons = [
    [['0', '0'], ['10', '0'], ['0', '10']], // triangle
    [['0', '0'], ['10', '0'], ['10', '10'], ['0', '10']], // quad
    [['0', '0'], ['8', '0'], ['10', '5'], ['5', '10'], ['0', '6']], // pentagon
    [['2', '0'], ['8', '0'], ['10', '5'], ['8', '10'], ['2', '10'], ['0', '5']], // hexagon
  ];
  for (const raw of polygons) {
    const poly = raw.map(parsePoint);
    assertConvexPolygon(poly);
    const b = box('3', '5', '3', '4');
    const report = analyzeBox(b, poly);
    assert.equal(report.corners.length, 4);
    for (const c of report.corners) {
      assert.equal(typeof c.inside, 'boolean');
      assert.match(c.x, /^-?\d+(\/\d+)?$/);
    }
    assert.equal(report.allCornersInside, true);
    assert.equal(report.intersects, true);
    assert.equal(classifyBox(b, poly), 'conforming');
  }
});

test('acceptance 2: box exactly touching one polygon edge is conforming', () => {
  // box shares the segment x=0, y in [3,5] with the square boundary
  const b = box('0', '2', '3', '5');
  const report = analyzeBox(b, SQUARE);
  assert.equal(report.allCornersInside, true);
  assert.equal(classifyBox(b, SQUARE), 'conforming');
});

test('classification: crossing boundary is uncertain, fully outside is nonconforming', () => {
  assert.equal(classifyBox(box('8', '12', '1', '2'), SQUARE), 'uncertain');
  assert.equal(classifyBox(box('11', '12', '1', '2'), SQUARE), 'nonconforming');
  // touching the boundary from outside shares a boundary point -> uncertain
  assert.equal(classifyBox(box('10', '12', '1', '2'), SQUARE), 'uncertain');
  // polygon vertex poking into the box
  assert.equal(classifyBox(box('9', '12', '9', '12'), SQUARE), 'uncertain');
  assert.equal(classifyBox(box('10.5', '12', '10.5', '12'), SQUARE), 'nonconforming');
});
