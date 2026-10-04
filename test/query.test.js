import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineageGraph } from '../src/graph.js';
import { parseSource } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { execute } from '../src/vm.js';

const attrs = (type, date) => ({ type, date, name: `${type}-${date}` });

// Acceptance scenario 1: two semi-finished batches share one raw material.
//
//   LOT-2025-0001 (raw flour)
//    ├──> LOT-2025-0002 (semi dough-a)
//    └──> LOT-2025-0003 (semi dough-b)
//          0002 ──> LOT-2025-0004 (finished bread)
//          0003 ──> LOT-2025-0004
function sharedMaterialGraph() {
  const g = new LineageGraph();
  g.applyTransaction([
    { op: 'add', id: 'LOT-2025-0001', attrs: attrs('raw', '2025-01-01') },
    { op: 'add', id: 'LOT-2025-0002', attrs: attrs('semi', '2025-01-02') },
    { op: 'add', id: 'LOT-2025-0003', attrs: attrs('semi', '2025-01-03') },
    { op: 'add', id: 'LOT-2025-0004', attrs: attrs('finished', '2025-01-04') },
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' },
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0003' },
    { op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0004' },
    { op: 'link', from: 'LOT-2025-0003', to: 'LOT-2025-0004' },
  ]);
  return g;
}

function runQuery(graph, source) {
  return execute(compile(parseSource(source)), graph);
}

test('acceptance 1: shared raw material dedupes and sorts ancestors', () => {
  const g = sharedMaterialGraph();
  const { results } = runQuery(g, 'query ancestors(LOT-2025-0004);');
  assert.deepEqual(results[0].result, ['LOT-2025-0001', 'LOT-2025-0002', 'LOT-2025-0003']);
});

test('acceptance 1: descendants of the shared raw material are deduped and sorted', () => {
  const g = sharedMaterialGraph();
  const { results } = runQuery(g, 'query descendants(LOT-2025-0001);');
  assert.deepEqual(results[0].result, ['LOT-2025-0002', 'LOT-2025-0003', 'LOT-2025-0004']);
});

test('where filter with pratt-parsed expression', () => {
  const g = sharedMaterialGraph();
  const { results } = runQuery(
    g,
    'query descendants(LOT-2025-0001) where type == "semi" and date >= 2025-01-03 or type == "finished";',
  );
  assert.deepEqual(results[0].result, ['LOT-2025-0003', 'LOT-2025-0004']);
});

test('let variables feed later queries', () => {
  const g = sharedMaterialGraph();
  const { results } = runQuery(
    g,
    'let up = ancestors(LOT-2025-0004);\nquery up where type == "semi";',
  );
  assert.deepEqual(results[0].result, ['LOT-2025-0002', 'LOT-2025-0003']);
});

test('shortestPath query yields the path', () => {
  const g = sharedMaterialGraph();
  const { results, certificates } = runQuery(g, 'query shortestPath(LOT-2025-0001, LOT-2025-0004);');
  assert.deepEqual(results[0].result, ['LOT-2025-0001', 'LOT-2025-0002', 'LOT-2025-0004']);
  assert.equal(certificates[0].resultKind, 'path');
  assert.deepEqual(certificates[0].paths, [['LOT-2025-0001', 'LOT-2025-0002', 'LOT-2025-0004']]);
});

test('acceptance 2: undo restores lineage, redo produces a different certificate version', () => {
  const g = sharedMaterialGraph();
  // Erroneous entry: dough-b (0003) was never an ingredient of dough-a (0002).
  g.applyTransaction([{ op: 'link', from: 'LOT-2025-0003', to: 'LOT-2025-0002' }]);
  const polluted = runQuery(g, 'query ancestors(LOT-2025-0002);');
  assert.deepEqual(polluted.results[0].result, ['LOT-2025-0001', 'LOT-2025-0003']);

  g.undo();
  const restored = runQuery(g, 'query ancestors(LOT-2025-0002);');
  assert.deepEqual(restored.results[0].result, ['LOT-2025-0001']);
  const restoredVersion = restored.certificates[0].graphVersion;

  g.redo();
  const redone = runQuery(g, 'query ancestors(LOT-2025-0002);');
  assert.deepEqual(redone.results[0].result, ['LOT-2025-0001', 'LOT-2025-0003']);
  assert.notEqual(redone.certificates[0].graphVersion, restoredVersion);
  assert.notEqual(redone.certificates[0].hash, restored.certificates[0].hash);
});

test('every query emits a certificate with command hash, version and path hashes', () => {
  const g = sharedMaterialGraph();
  const { certificates } = runQuery(g, 'query ancestors(LOT-2025-0004);');
  const cert = certificates[0];
  assert.equal(cert.commandHash, g.commandHash());
  assert.equal(cert.graphVersion, g.version);
  assert.equal(cert.paths.length, 3);
  assert.equal(cert.pathHashes.length, 3);
  assert.match(cert.hash, /^[0-9a-f]{64}$/);
});
