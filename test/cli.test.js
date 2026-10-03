import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSession } from '../src/session.js';

test('CLI session: init, query, transactional failure, undo', () => {
  const { results } = runSession({
    commands: [
      { op: 'init', vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }] },
      { op: 'query', segment: { p: { x: 1, y: 1 }, q: { x: 3, y: 1 } } },
      { op: 'updateVertex', index: 1, point: { x: 2, y: 3 } }, // non-convex -> E_GEOMETRY, rollback
      { op: 'state' },
      { op: 'undo' }, // nothing committed after init -> no change
      { op: 'query', segment: { p: { x: 2, y: 0 }, q: { x: 2, y: 2 } } },
    ],
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[1].result.classification, 'inside');
  assert.equal(results[1].result.minGapSquared, '1');
  assert.equal(results[2].ok, false);
  assert.equal(results[2].error.code, 'E_GEOMETRY');
  assert.equal(results[3].state.vertexCount, 4); // rolled back
  assert.equal(results[4].changed, false);
  assert.equal(results[5].result.classification, 'touching'); // endpoint-only contact
  assert.equal(results[5].result.minGapSquared, '0');
});

test('CLI: E_EMPTY for too few vertices and for query before init', () => {
  const { results } = runSession([
    { op: 'query', segment: { p: { x: 0, y: 0 }, q: { x: 1, y: 1 } } },
    { op: 'init', vertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
  ]);
  assert.equal(results[0].error.code, 'E_EMPTY');
  assert.equal(results[1].error.code, 'E_EMPTY');
});

test('CLI: E_GEOMETRY for self-intersecting polygon', () => {
  const { results } = runSession([
    { op: 'init', vertices: [{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 4, y: 0 }, { x: 0, y: 4 }] },
  ]);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error.code, 'E_GEOMETRY');
});

test('CLI: unknown op yields E_INPUT', () => {
  const { results } = runSession([{ op: 'explode' }]);
  assert.equal(results[0].error.code, 'E_INPUT');
});

test('CLI: certificate fields present and fractional', () => {
  const { results } = runSession({
    commands: [
      { op: 'init', vertices: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 0, y: 6 }] },
      { op: 'query', segment: { p: { x: 2, y: 3 }, q: { x: 2, y: 3 } } },
    ],
  });
  const cert = results[1].result.certificate;
  assert.equal(cert.minGapSquared, '1/2');
  assert.equal(cert.edgeParam, '7/12');
  assert.deepEqual(cert.pointOnEdge, { x: '5/2', y: '7/2' });
  assert.equal(cert.nearestEdge, 1);
});
