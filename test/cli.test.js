import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../cli.js';

function run(doc) {
  return runCli(JSON.stringify(doc));
}

test('CLI reads JSON from stdin and executes ops in order', () => {
  const res = run({
    now: 1000,
    ops: [
      { op: 'add_batch', id: 'b1', concentration: 1.0, expiry: 5000 },
      { op: 'add_batch', id: 'b2', concentration: 2.0, expiry: null },
      { op: 'add_result', id: 'r1', batch: 'b1', protocol: 'p1' },
      { op: 'add_node', id: 'k1', kind: 'conclusion', deps: ['r1'] },
      { op: 'status', id: 'k1' },
      { op: 'set_expiry', id: 'b1', expiry: 500 },
      { op: 'status', id: 'k1' },
      { op: 'add_substitute', result: 'r1', batch: 'b2' },
      { op: 'status', id: 'r1' },
      { op: 'certificate', id: 'k1' },
      { op: 'undo' },
      { op: 'status', id: 'r1' },
      { op: 'redo' },
      { op: 'status', id: 'r1' },
    ],
  });
  assert.equal(res.ok, true);
  const r = res.results;
  assert.equal(r[4].value.status, 'valid');
  assert.equal(r[6].value.status, 'invalid');
  assert.deepEqual(r[6].value.invalidationPath, ['b1', 'r1', 'k1']);
  assert.equal(r[8].value.status, 'valid');
  assert.equal(r[8].value.chosenBatch, 'b2');
  assert.equal(r[9].value.status, 'valid');
  assert.match(r[9].value.stateHash, /^[0-9a-f]{64}$/);
  assert.equal(r[11].value.status, 'invalid');
  assert.equal(r[13].value.status, 'valid');
});

test('CLI reports E_CYCLE and E_REF as structured errors', () => {
  const res = run({
    now: 0,
    ops: [
      { op: 'add_batch', id: 'b1' },
      { op: 'add_result', id: 'r1', batch: 'b1', protocol: 'p1' },
      { op: 'add_edge', node: 'r1', depends_on: 'r1' },
      { op: 'add_result', id: 'r2', batch: 'ghost', protocol: 'p1' },
      { op: 'status', id: 'r1' },
    ],
  });
  assert.equal(res.results[2].ok, false);
  assert.equal(res.results[2].error.code, 'E_CYCLE');
  assert.equal(res.results[3].ok, false);
  assert.equal(res.results[3].error.code, 'E_REF');
  assert.equal(res.results[4].value.status, 'valid');
});

test('CLI accepts ISO 8601 expiry strings and rejects bad JSON', () => {
  const res = run({
    now: Date.parse('2026-01-01T00:00:00Z'),
    ops: [
      { op: 'add_batch', id: 'b1', expiry: '2026-06-01T00:00:00Z' },
      { op: 'add_result', id: 'r1', batch: 'b1', protocol: 'p1' },
      { op: 'status', id: 'r1' },
    ],
  });
  assert.equal(res.results[2].value.status, 'valid');
  const bad = runCli('{nope');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'E_PARSE');
});
