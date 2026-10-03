import test from 'node:test';
import assert from 'node:assert/strict';
import { SafeZone, pointToJSON } from '../src/safezone.js';

const square = () => new SafeZone([[0, 0], [4, 0], [4, 4], [0, 4]]);
const key = (verts) => verts.map((p) => `${p.x}+${p.y}i`).join(' ');

test('addVertex commits and undo/redo move between versions', () => {
  const z = square();
  const r = z.addVertex([2, 5], 3);
  assert.equal(r.ok, true);
  assert.equal(z.vertices.length, 5);
  assert.equal(z.canUndo, true);

  assert.equal(z.undo().ok, true);
  assert.equal(z.vertices.length, 4);
  assert.equal(z.canRedo, true);

  assert.equal(z.redo().ok, true);
  assert.equal(z.vertices.length, 5);
});

test('new commit after undo clears the redo stack', () => {
  const z = square();
  z.addVertex([2, 5], 3);
  z.undo();
  assert.equal(z.canRedo, true);
  z.updateVertex(0, [1, 1]);
  assert.equal(z.canRedo, false);
  assert.equal(z.redo().ok, false);
});

test('updateVertex/removeVertex commit valid results', () => {
  const z = square();
  assert.equal(z.updateVertex(0, [-1, -1]).ok, true);
  assert.equal(key(z.vertices), '-1+-1i 4+0i 4+4i 0+4i');
  assert.equal(z.removeVertex(2).ok, true);
  assert.equal(z.vertices.length, 3);
});

test('acceptance 3: invalid transaction rolls back, undo info unchanged', () => {
  const z = square();
  z.addVertex([2, 5], 3); // commit a second version so undo is available
  const beforeVerts = key(z.vertices);
  const beforeVersion = z.version;
  const canUndoBefore = z.canUndo;
  const canRedoBefore = z.canRedo;

  // Non-convex: moving vertex 2 inward creates a reflex corner.
  const bad = z.updateVertex(2, [1, 1]);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'E_GEOMETRY');

  assert.equal(key(z.vertices), beforeVerts);
  assert.equal(z.version, beforeVersion);
  assert.equal(z.canUndo, canUndoBefore);
  assert.equal(z.canRedo, canRedoBefore);

  // Duplicate point is also rejected and rolled back.
  const dup = z.updateVertex(1, [4, 4]);
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, 'E_GEOMETRY');
  assert.equal(key(z.vertices), beforeVerts);

  // Undo still steps to exactly the pre-existing previous version.
  assert.equal(z.undo().ok, true);
  assert.equal(key(z.vertices), '0+0i 4+0i 4+4i 0+4i');
});

test('batch transact is atomic: one bad op rolls back everything', () => {
  const z = square();
  const before = key(z.vertices);
  const r = z.transact([
    { op: 'updateVertex', index: 0, point: [-1, 0] },
    { op: 'updateVertex', index: 2, point: [1, 1] }, // makes it non-convex
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_GEOMETRY');
  assert.equal(key(z.vertices), before);
  assert.equal(z.version, 0);
});

test('removeVertex below 3 vertices fails with E_EMPTY and rolls back', () => {
  const z = new SafeZone([[0, 0], [2, 0], [1, 2]]);
  const r = z.removeVertex(0);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_EMPTY');
  assert.equal(z.vertices.length, 3);
});

test('out-of-range indices fail with E_INDEX and roll back', () => {
  const z = square();
  assert.equal(z.updateVertex(9, [1, 1]).error.code, 'E_INDEX');
  assert.equal(z.removeVertex(-1).error.code, 'E_INDEX');
  assert.equal(z.vertices.length, 4);
});

test('constructor rejects invalid initial polygons', () => {
  assert.throws(() => new SafeZone([[0, 0], [2, 0], [1, '1/2'], [0, 2]]), /non-convex/);
  try {
    new SafeZone([[0, 0], [2, 2], [2, 0], [0, 2]]);
    assert.unreachable();
  } catch (e) {
    assert.equal(e.code, 'E_GEOMETRY');
  }
});

test('undo/redo on empty history report E_UNDO without throwing', () => {
  const z = new SafeZone();
  assert.equal(z.undo().error.code, 'E_UNDO');
  assert.equal(z.redo().error.code, 'E_UNDO');
  assert.equal(z.analyzeSegment([0, 0], [1, 1]).error.code, 'E_EMPTY');
});
