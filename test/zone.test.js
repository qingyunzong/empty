import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafeZone } from '../src/zone.js';

const square = () => new SafeZone([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]);

test('classification: inside / touching / outside', () => {
  const z = square();
  assert.equal(z.query({ p: { x: 1, y: 1 }, q: { x: 2, y: 2 } }).classification, 'inside');
  assert.equal(z.query({ p: { x: 1, y: 1 }, q: { x: 2, y: 0 } }).classification, 'touching');
  assert.equal(z.query({ p: { x: 1, y: 1 }, q: { x: 5, y: 1 } }).classification, 'outside');
  assert.equal(z.query({ p: { x: -1, y: 2 }, q: { x: 5, y: 2 } }).classification, 'outside');
});

test('endpoint-only contact is touching, not crossing out', () => {
  const z = square();
  const r = z.query({ p: { x: 2, y: 0 }, q: { x: 2, y: 2 } });
  assert.equal(r.classification, 'touching');
  assert.equal(r.minGapSquared, '0');
});

test('segment lying on boundary has zero gap', () => {
  const z = square();
  const r = z.query({ p: { x: 0, y: 0 }, q: { x: 4, y: 0 } });
  assert.equal(r.classification, 'touching');
  assert.equal(r.minGapSquared, '0');
  assert.equal(r.nearestEdge, 0);
});

test('inside segment: exact squared gap and certificate', () => {
  const z = square();
  const r = z.query({ p: { x: 1, y: 1 }, q: { x: 3, y: 1 } });
  assert.equal(r.classification, 'inside');
  assert.equal(r.minGapSquared, '1'); // distance to y=0 edge
  assert.equal(r.nearestEdge, 0);
  const c = r.certificate;
  assert.equal(c.pointOnEdge.y, '0');
  assert.equal(c.pointOnSegment.y, '1');
  assert.equal(c.allEdgeGapsSquared.length, 4);
  assert.deepEqual(c.allEdgeGapsSquared, ['1', '1', '9', '1']);
});

test('fractional projection parameters in certificate', () => {
  const z = new SafeZone([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 0, y: 6 }]);
  const r = z.query({ p: { x: 2, y: 3 }, q: { x: 2, y: 3 } });
  assert.equal(r.minGapSquared, '1/2');
  assert.equal(r.nearestEdge, 1); // hypotenuse (6,0)->(0,6)
  assert.equal(r.certificate.edgeParam, '7/12');
  assert.equal(r.certificate.pointOnEdge.x, '5/2');
  assert.equal(r.certificate.pointOnEdge.y, '7/2');
});

test('undo/redo across committed transactions', () => {
  const z = new SafeZone([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }]);
  z.addVertex(2, { x: 4, y: 4 }); // triangle -> square
  assert.equal(z.state().vertexCount, 4);
  const u = z.undo();
  assert.equal(u.changed, true);
  assert.equal(z.state().vertexCount, 3);
  const r = z.redo();
  assert.equal(r.changed, true);
  assert.equal(z.state().vertexCount, 4);
  assert.deepEqual(z.state().vertices[2], { x: '4', y: '4' });
});

test('undo/redo on empty history reports no change', () => {
  const z = square();
  assert.equal(z.undo().changed, false);
  assert.equal(z.redo().changed, false);
});

test('removeVertex transactional and undoable', () => {
  const z = square();
  z.removeVertex(3);
  assert.equal(z.state().vertexCount, 3);
  z.undo();
  assert.equal(z.state().vertexCount, 4);
});

test('removeVertex below 3 vertices rolls back with E_EMPTY', () => {
  const z = new SafeZone([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }]);
  assert.throws(() => z.removeVertex(0), (e) => e.code === 'E_EMPTY');
  assert.equal(z.state().vertexCount, 3);
  assert.equal(z.state().undoDepth, 0);
});

test('query before init raises E_EMPTY', () => {
  const z = new SafeZone();
  assert.throws(() => z.query({ p: { x: 0, y: 0 }, q: { x: 1, y: 1 } }), (e) => e.code === 'E_EMPTY');
});
