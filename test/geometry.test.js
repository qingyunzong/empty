import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePolygon, parsePoint, segSegDist2, pointSegDist2 } from '../src/geometry.js';
import { Frac } from '../src/fraction.js';

const P = (x, y) => parsePoint({ x, y });

test('E_EMPTY for fewer than 3 vertices', () => {
  assert.throws(() => validatePolygon([P(0, 0), P(1, 1)]), (e) => e.code === 'E_EMPTY');
  assert.throws(() => validatePolygon([]), (e) => e.code === 'E_EMPTY');
});

test('E_GEOMETRY for non-convex polygon', () => {
  const vs = [P(0, 0), P(2, 3), P(4, 4), P(0, 4)];
  assert.throws(() => validatePolygon(vs), (e) => e.code === 'E_GEOMETRY' && /not convex/.test(e.message));
});

test('E_GEOMETRY for duplicate vertices', () => {
  const vs = [P(0, 0), P(4, 0), P(4, 0), P(0, 4)];
  assert.throws(() => validatePolygon(vs), (e) => e.code === 'E_GEOMETRY' && /duplicate/.test(e.message));
});

test('E_GEOMETRY for self-intersecting (bowtie) polygon', () => {
  const vs = [P(0, 0), P(4, 4), P(4, 0), P(0, 4)];
  assert.throws(() => validatePolygon(vs), (e) => e.code === 'E_GEOMETRY');
});

test('E_GEOMETRY for reversed collinear spike', () => {
  const vs = [P(0, 0), P(2, 0), P(1, 0), P(0, 3)];
  assert.throws(() => validatePolygon(vs), (e) => e.code === 'E_GEOMETRY');
});

test('collinear edges allowed in convex polygon', () => {
  const vs = [P(0, 0), P(2, 0), P(4, 0), P(4, 4), P(0, 4)];
  assert.equal(validatePolygon(vs), 1);
});

test('clockwise convex polygon accepted', () => {
  const vs = [P(0, 0), P(0, 4), P(4, 4), P(4, 0)];
  assert.equal(validatePolygon(vs), -1);
});

test('point-segment distance with fractional projection parameter', () => {
  // edge (6,0)-(0,6), point (2,3): t = 42/72 = 7/12, d2 = 1/2
  const r = pointSegDist2(P(2, 3), P(6, 0), P(0, 6));
  assert.equal(r.t.toString(), '7/12');
  assert.equal(r.d2.toString(), '1/2');
});

test('segment-segment distance zero on intersection', () => {
  const r = segSegDist2(P(0, 0), P(4, 0), P(2, -1), P(2, 1));
  assert.equal(r.d2.toString(), '0');
  assert.equal(r.t1.toString(), '1/2');
  assert.equal(r.t2.toString(), '1/2');
});

test('segment-segment distance between parallel segments', () => {
  const r = segSegDist2(P(0, 0), P(4, 0), P(1, 3), P(3, 3));
  assert.equal(r.d2.toString(), '9');
});
