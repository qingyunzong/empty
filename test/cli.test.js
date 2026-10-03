import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/cli-core.js';

// The sandbox forbids spawning child processes, so the CLI is tested through
// a full JSON round-trip of the same handler the cli.js entrypoint invokes.
function runCli(input) {
  const request = JSON.parse(JSON.stringify(input));
  return JSON.parse(JSON.stringify(handleRequest(request)));
}

test('CLI analyzes a segment from a JSON request', () => {
  const out = runCli({
    vertices: [[0, 0], [4, 0], [4, 4], [0, 4]],
    segment: [[1, 1], [3, 1]],
  });
  assert.equal(out.ok, true);
  assert.equal(out.analysis.status, 'inside');
  assert.equal(out.analysis.gapSquared, '1');
  assert.equal(out.analysis.nearestEdge.index, 0);
  assert.deepEqual(out.analysis.pointOnEdge, { x: '1', y: '0' });
  assert.equal(out.analysis.tEdge, '1/4');
  assert.equal(out.analysis.certificate.edges.length, 4);
  assert.equal(out.analysis.certificate.checks.minIsMinimal, true);
});

test('CLI applies ops transactionally and reports rollback', () => {
  const out = runCli({
    vertices: [[0, 0], [4, 0], [4, 4], [0, 4]],
    ops: [
      { op: 'updateVertex', index: 2, point: [1, 1] }, // non-convex -> rollback
      { op: 'updateVertex', index: 2, point: [3, 3] }, // ok
      { op: 'undo' },
      { op: 'redo' },
    ],
    segment: [[1, 1], [3, 3]],
  });
  assert.equal(out.ok, true);
  assert.equal(out.ops[0].ok, false);
  assert.equal(out.ops[0].error.code, 'E_GEOMETRY');
  assert.equal(out.ops[1].ok, true);
  assert.equal(out.ops[2].ok, true);
  assert.equal(out.ops[3].ok, true);
  assert.equal(out.analysis.status, 'touching');
  assert.equal(out.analysis.gapSquared, '0');
});

test('CLI reports E_GEOMETRY for invalid initial polygon', () => {
  const out = runCli({ vertices: [[0, 0], [2, 2], [2, 0], [0, 2]] });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'E_GEOMETRY');
});

test('CLI reports E_EMPTY when a transaction would drop below 3 vertices', () => {
  const out = runCli({
    vertices: [[0, 0], [2, 0], [1, 2]],
    ops: [{ op: 'removeVertex', index: 0 }],
    segment: [['1/2', '1/2'], [1, 1]],
  });
  assert.equal(out.ops[0].error.code, 'E_EMPTY');
  assert.equal(out.analysis.status, 'inside'); // polygon unchanged after rollback
});

test('CLI rejects malformed requests with E_PARSE', () => {
  assert.equal(handleRequest(null).error.code, 'E_PARSE');
  assert.equal(handleRequest([1, 2, 3]).error.code, 'E_PARSE');
  const out = runCli({ vertices: [[0, 0], [2, 0], [1, 2]], segment: [[0, 0]] });
  assert.equal(out.analysis.error.code, 'E_PARSE');
});

test('CLI accepts rational coordinates as strings, pairs and objects', () => {
  const out = runCli({
    vertices: [
      [0, 0],
      ['5/2', 0],
      [0, { num: 7, den: 3 }],
    ],
    segment: [
      ['1/3', '1/3'],
      ['1/3', '1/3'],
    ],
  });
  assert.equal(out.ok, true);
  assert.equal(out.analysis.status, 'inside');
  assert.match(out.analysis.gapSquared, /^-?\d+(\/\d+)?$/);
  assert.equal(out.analysis.degenerate, true);
});
