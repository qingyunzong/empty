import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamicGraph } from '../src/graph.js';
import { processLine } from '../cli.js';

// The CLI reads JSONL lines from stdin and answers with processLine per line;
// driving it in-process exercises the exact same dispatch and error mapping.
function runSession(lines) {
  const graph = new DynamicGraph();
  return lines.map((l) => processLine(graph, typeof l === 'string' ? l : JSON.stringify(l)));
}

test('cli: JSONL command session end to end', () => {
  const outputs = runSession([
    { op: 'add_edge', id: 'a', from: 'DOCK', to: 'WS1', cost: 4 },
    { op: 'add_edge', id: 'b', from: 'WS1', to: 'WS2', cost: 4 },
    { op: 'add_edge', id: 'c', from: 'DOCK', to: 'WS2', cost: 20 },
    { op: 'query', from: 'DOCK', to: 'WS2' },
    { op: 'set_cost', id: 'c', cost: 3 },
    { op: 'query', from: 'DOCK', to: 'WS2' },
    { op: 'close', id: 'c' },
    { op: 'close', id: 'a' },
    { op: 'close', id: 'b' },
    { op: 'query', from: 'DOCK', to: 'WS2' },
    { op: 'undo' },
    { op: 'query', from: 'DOCK', to: 'WS2' },
    { op: 'bogus' },
    'this is not json',
  ]);

  assert.equal(outputs[0].ok, true);
  assert.equal(outputs[0].id, 'a');
  assert.equal(outputs[3].cost, 8);
  assert.deepEqual(outputs[3].path, ['DOCK', 'WS1', 'WS2']);
  assert.ok(outputs[3].cert);
  assert.equal(outputs[5].cost, 3);
  assert.deepEqual(outputs[5].path, ['DOCK', 'WS2']);
  assert.equal(outputs[9].error, 'NO_PATH');
  assert.equal(outputs[10].ok, true); // undo reopens edge b
  assert.equal(outputs[11].error, 'NO_PATH'); // a and c still closed
  assert.equal(outputs[12].error, 'INVALID_INPUT');
  assert.equal(outputs[13].error, 'INVALID_INPUT'); // malformed JSON line
});

test('cli: verify accepts fresh cert and rejects tampered/stale ones', () => {
  const setup = runSession([
    { op: 'add_edge', id: 'a', from: 'S', to: 'A', cost: 2 },
    { op: 'add_edge', id: 'b', from: 'A', to: 'T', cost: 3 },
    { op: 'query', from: 'S', to: 'T' },
  ]);
  const cert = setup[2].cert;
  assert.equal(cert.version, 2);

  const outputs = runSession([
    { op: 'add_edge', id: 'a', from: 'S', to: 'A', cost: 2 },
    { op: 'add_edge', id: 'b', from: 'A', to: 'T', cost: 3 },
    { op: 'add_edge', id: 'd', from: 'A', to: 'X', cost: 1 },
    { op: 'verify', cert }, // version mismatch (graph moved on) -> CERT_INVALID
    { op: 'query', from: 'S', to: 'T' },
    // matches current version; extra potential for the new node X
    { op: 'verify', cert: { ...cert, version: 3, dist: { ...cert.dist, X: 3 } } },
    { op: 'verify', cert: { ...cert, version: 3, cost: cert.cost - 1, dist: { ...cert.dist, X: 3 } } }, // forged
    { op: 'set_cost', id: 'a', cost: 9 },
    { op: 'verify', cert: { ...cert, version: 3, dist: { ...cert.dist, X: 3 } } }, // stale after mutation
  ]);

  assert.equal(outputs[3].error, 'CERT_INVALID');
  assert.equal(outputs[4].ok, true);
  assert.equal(outputs[4].cert.version, 3);
  assert.equal(outputs[5].ok, true);
  assert.equal(outputs[6].error, 'CERT_INVALID');
  assert.equal(outputs[8].error, 'CERT_INVALID');
});

test('cli: every response is a single JSON object with ok or error', () => {
  const outputs = runSession([
    { op: 'add_edge', id: 'a', from: 'S', to: 'T', cost: 1 },
    { op: 'add_edge', id: 'a', from: 'S', to: 'T', cost: 1 }, // duplicate id
    { op: 'close', id: 'nope' },
    { op: 'query', from: 'T', to: 'S' }, // directed: unreachable
    '{bad json',
  ]);
  for (const out of outputs) {
    assert.equal(typeof out, 'object');
    assert.ok('ok' in out || 'error' in out);
  }
  assert.equal(outputs[1].error, 'CONFLICT');
  assert.equal(outputs[2].error, 'INVALID_INPUT');
  assert.equal(outputs[3].error, 'NO_PATH');
  assert.equal(outputs[4].error, 'INVALID_INPUT');
});
