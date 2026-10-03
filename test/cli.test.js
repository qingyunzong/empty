import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';

function runCli(commands) {
  const session = createSession();
  const input = commands
    .map((cmd) => (typeof cmd === 'string' ? cmd : JSON.stringify(cmd)))
    .join('\n');
  return input
    .split('\n')
    .map((line) => session.handleLine(line))
    .filter((result) => result !== null);
}

test('cli processes NDJSON commands end to end', () => {
  const results = runCli([
    { op: 'add-edge', from: 0, to: 1 },
    { op: 'add-edge', from: 1, to: 2 },
    { op: 'snapshot' },
    { op: 'add-edge', from: 2, to: 0 },
    { op: 'query' },
    { op: 'rollback', snapshot: 1 },
    { op: 'query' },
    { op: 'add-edge', from: 0, to: 1 },
    { op: 'add-edge', from: -1, to: 0 },
    { op: 'rollback', snapshot: 42 },
    { op: 'rollback', snapshot: 0 },
    { op: 'frobnicate' },
    'not json',
  ]);

  assert.deepEqual(results[0], { ok: true });
  assert.deepEqual(results[1], { ok: true });
  assert.equal(results[2].snapshot, 1);
  assert.match(results[2].hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(results[3], { ok: true });
  assert.deepEqual(results[4].components, [[0, 1, 2]]);
  assert.deepEqual(results[5], { ok: true, snapshot: 1, hash: results[2].hash });
  assert.deepEqual(results[6].components, [[0], [1], [2]]);
  assert.deepEqual(results[6].topoOrder, [[0], [1], [2]]);
  assert.equal(results[7].error, 'duplicate-edge');
  assert.equal(results[8].error, 'negative-id');
  assert.equal(results[9].error, 'future-snapshot');
  assert.equal(results[10].error, 'unknown-snapshot');
  assert.equal(results[11].error, 'unknown-op');
  assert.equal(results[12].error, 'invalid-command');
});

test('cli query returns representative certificates with valid paths', () => {
  const results = runCli([
    { op: 'add-edge', from: 0, to: 1 },
    { op: 'add-edge', from: 1, to: 2 },
    { op: 'add-edge', from: 2, to: 0 },
    { op: 'add-edge', from: 2, to: 3 },
    { op: 'query' },
  ]);
  const query = results[4];
  assert.deepEqual(query.components, [[0, 1, 2], [3]]);
  assert.deepEqual(query.topoOrder, [[0, 1, 2], [3]]);
  const cert = query.certificates[0];
  assert.equal(cert.representative, 0);
  assert.deepEqual(cert.proofs['2'].fromRepresentative, [0, 1, 2]);
  assert.deepEqual(cert.proofs['2'].toRepresentative, [2, 0]);
});
