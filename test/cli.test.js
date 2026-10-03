'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSession } = require('../cli');

function run(input) {
  return runSession(input).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('CLI: full NDJSON session over stdin', () => {
  const lines = [
    JSON.stringify({ type: 'add-edge', id: 'e1', a: 'A', b: 'B', bandwidth: 100 }),
    JSON.stringify({ type: 'add-edge', id: 'e2', a: 'B', b: 'D', bandwidth: 100 }),
    JSON.stringify({ type: 'add-edge', id: 'e3', a: 'A', b: 'C', bandwidth: 100 }),
    JSON.stringify({ type: 'add-edge', id: 'e4', a: 'C', b: 'D', bandwidth: 100 }),
    JSON.stringify({ type: 'close-edge', id: 'e1' }),
    JSON.stringify({ type: 'cancel-batch', batchId: 'b1', payments: [{ id: 'p1', from: 'A', to: 'D', amount: 10 }] }),
    JSON.stringify({ type: 'open-edge', id: 'e1' }),
    JSON.stringify({ type: 'cancel-batch', batchId: 'b2', payments: [{ id: 'p2', from: 'A', to: 'D', amount: 5 }] }),
  ].join('\n') + '\n';

  const out = run(lines);
  assert.equal(out.length, 8);
  assert.ok(out.every((r) => r.ok));
  assert.deepEqual(out[5].payments[0].path, ['A', 'C', 'D']);
  assert.deepEqual(out[7].payments[0].path, ['A', 'B', 'D']);
  assert.deepEqual(out[7].bridges, []);
  assert.deepEqual(out[7].components, [['A', 'B', 'C', 'D']]);
});

test('CLI: closing unique bridge yields bridge certificate, batch is atomic', () => {
  const lines = [
    JSON.stringify({ type: 'add-edge', id: 'e1', a: 'A', b: 'B', bandwidth: 1 }),
    JSON.stringify({ type: 'add-edge', id: 'e2', a: 'B', b: 'C', bandwidth: 1 }),
    JSON.stringify({ type: 'close-edge', id: 'e2' }),
    JSON.stringify({
      type: 'cancel-batch',
      batchId: 'b1',
      payments: [
        { id: 'p1', from: 'A', to: 'B' },
        { id: 'p2', from: 'A', to: 'C' },
      ],
    }),
    // batch failed atomically; e1 must still be open, so this succeeds
    JSON.stringify({ type: 'cancel-batch', batchId: 'b3', payments: [{ id: 'p3', from: 'A', to: 'B' }] }),
  ].join('\n') + '\n';

  const out = run(lines);
  assert.equal(out[3].ok, false);
  assert.equal(out[3].error.code, 'DISCONNECTED');
  assert.equal(out[3].bridgeCertificate.maintenanceEdges[0].splitsGraph, true);
  assert.deepEqual(out[3].bridgeCertificate.components, [['A', 'B'], ['C']]);
  assert.equal(out[4].ok, true);
  assert.deepEqual(out[4].payments[0].path, ['A', 'B']);
});

test('CLI: malformed input and domain errors are reported per line', () => {
  const lines = [
    'this is not json',
    JSON.stringify({ type: 'fly-to-moon' }),
    JSON.stringify({ type: 'add-edge', id: 'e1', a: 'A', b: 'A', bandwidth: 1 }),
    JSON.stringify({ type: 'add-edge', id: 'e1', a: 'A', b: 'B', bandwidth: 1 }),
    JSON.stringify({ type: 'close-edge', id: 'e1' }),
    JSON.stringify({ type: 'close-edge', id: 'e1' }),
    JSON.stringify({ type: 'cancel-batch', batchId: 'b', payments: [] }),
    JSON.stringify({ type: 'cancel-batch', batchId: 'b', payments: [{ id: 'p', from: 'A', to: 'GHOST' }] }),
  ].join('\n') + '\n';

  const out = run(lines);
  assert.deepEqual(out.map((r) => r.ok), [false, false, false, true, true, false, false, false]);
  assert.deepEqual(
    out.map((r) => (r.ok ? null : r.error.code)),
    ['INVALID_JSON', 'UNKNOWN_COMMAND', 'SELF_LOOP', null, null, 'EDGE_ALREADY_CLOSED', 'EMPTY_BATCH', 'UNKNOWN_NODE'],
  );
});
