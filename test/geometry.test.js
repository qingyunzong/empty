import test from 'node:test';
import assert from 'node:assert/strict';
import { point, validatePolygon } from '../src/geometry.js';

const P = (...coords) => coords.map(([x, y]) => point(x, y));

test('accepts convex polygons in both orientations', () => {
  const ccw = P([0, 0], [4, 0], [4, 4], [0, 4]);
  assert.deepEqual(validatePolygon(ccw), { ok: true, orientation: 1 });
  const cw = P([0, 0], [0, 4], [4, 4], [4, 0]);
  assert.deepEqual(validatePolygon(cw), { ok: true, orientation: -1 });
});

test('accepts collinear vertices on an edge', () => {
  const v = P([0, 0], [1, 0], [2, 0], [2, 2], [0, 2]);
  assert.equal(validatePolygon(v).ok, true);
});

test('rejects non-convex polygon with E_GEOMETRY', () => {
  const v = P([0, 0], [2, 0], [1, 1], [2, 2], [0, 2]);
  const r = validatePolygon(v);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_GEOMETRY');
});

test('rejects self-intersecting bowtie with E_GEOMETRY', () => {
  const v = P([0, 0], [2, 2], [2, 0], [0, 2]);
  const r = validatePolygon(v);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_GEOMETRY');
});

test('rejects 180-degree reversal (overlapping collinear edges)', () => {
  const v = P([0, 0], [2, 0], [1, 0], [1, 1]);
  const r = validatePolygon(v);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_GEOMETRY');
});

test('rejects duplicate vertices with E_GEOMETRY', () => {
  const v = P([0, 0], [2, 0], [2, 2], [0, 0]);
  const r = validatePolygon(v);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_GEOMETRY');
});

test('rejects all-collinear degenerate polygon', () => {
  const v = P([0, 0], [1, 0], [2, 0]);
  const r = validatePolygon(v);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_GEOMETRY');
});

test('rejects fewer than 3 vertices with E_EMPTY', () => {
  assert.equal(validatePolygon(P([0, 0], [1, 1])).error.code, 'E_EMPTY');
  assert.equal(validatePolygon(P([0, 0])).error.code, 'E_EMPTY');
  assert.equal(validatePolygon([]).error.code, 'E_EMPTY');
});
