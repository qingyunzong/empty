import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineageGraph, LineageError } from '../src/graph.js';

const attrs = (type) => ({ type, date: '2025-01-01', name: `${type}-node` });

function baseGraph() {
  const g = new LineageGraph();
  g.applyTransaction([
    { op: 'add', id: 'LOT-2025-0001', attrs: attrs('raw') },
    { op: 'add', id: 'LOT-2025-0002', attrs: attrs('semi') },
    { op: 'add', id: 'LOT-2025-0003', attrs: attrs('finished') },
  ]);
  return g;
}

test('add/link/unlink basics', () => {
  const g = baseGraph();
  g.applyTransaction([{ op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' }]);
  assert.deepEqual(g.ancestors('LOT-2025-0002'), ['LOT-2025-0001']);
  assert.deepEqual(g.descendants('LOT-2025-0001'), ['LOT-2025-0002']);
  g.applyTransaction([{ op: 'unlink', from: 'LOT-2025-0001', to: 'LOT-2025-0002' }]);
  assert.deepEqual(g.ancestors('LOT-2025-0002'), []);
});

test('duplicate node and unknown node are rejected', () => {
  const g = baseGraph();
  assert.throws(
    () => g.applyTransaction([{ op: 'add', id: 'LOT-2025-0001', attrs: attrs('raw') }]),
    /already exists/,
  );
  assert.throws(
    () => g.applyTransaction([{ op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-9999' }]),
    /unknown lot/,
  );
});

test('attribute validation follows the static schema', () => {
  const g = new LineageGraph();
  assert.throws(
    () => g.applyTransaction([{ op: 'add', id: 'LOT-2025-0001', attrs: { type: 'weird', date: '2025-01-01' } }]),
    /must be one of/,
  );
  assert.throws(
    () => g.applyTransaction([{ op: 'add', id: 'LOT-2025-0001', attrs: { type: 'raw' } }]),
    /missing required attribute 'date'/,
  );
  assert.throws(
    () => g.applyTransaction([{ op: 'add', id: 'LOT-2025-0001', attrs: { type: 'raw', date: '2025-02-30' } }]),
    /valid YYYY-MM-DD/,
  );
});

test('direct and indirect cycles are rejected', () => {
  const g = baseGraph();
  g.applyTransaction([
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' },
    { op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0003' },
  ]);
  assert.throws(
    () => g.applyTransaction([{ op: 'link', from: 'LOT-2025-0003', to: 'LOT-2025-0001' }]),
    /cycle/,
  );
  assert.throws(
    () => g.applyTransaction([{ op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0001' }]),
    /cycle/,
  );
});

test('failed transaction leaves the graph untouched (atomicity)', () => {
  const g = baseGraph();
  g.applyTransaction([
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' },
    { op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0003' },
  ]);
  const versionBefore = g.version;
  const stateBefore = JSON.stringify(g.toJSON());
  assert.throws(
    () =>
      g.applyTransaction([
        { op: 'add', id: 'LOT-2025-0004', attrs: attrs('semi') },
        { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0004' },
        { op: 'link', from: 'LOT-2025-0003', to: 'LOT-2025-0001' },
      ]),
    /cycle/,
  );
  assert.equal(g.version, versionBefore);
  assert.equal(g.hasNode('LOT-2025-0004'), false);
  assert.equal(JSON.stringify(g.toJSON()), stateBefore);
});

test('undo/redo restore state and bump the version', () => {
  const g = baseGraph();
  g.applyTransaction([{ op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' }]);
  const v1 = g.version;
  g.undo();
  assert.deepEqual(g.descendants('LOT-2025-0001'), []);
  assert.ok(g.version > v1);
  g.redo();
  assert.deepEqual(g.descendants('LOT-2025-0001'), ['LOT-2025-0002']);
  assert.ok(g.version > v1 + 1);
});

test('undo/redo on empty stacks fail; new transaction clears redo', () => {
  const g = new LineageGraph();
  assert.throws(() => g.undo(), /nothing to undo/);
  g.applyTransaction([
    { op: 'add', id: 'LOT-2025-0001', attrs: attrs('raw') },
    { op: 'add', id: 'LOT-2025-0002', attrs: attrs('semi') },
    { op: 'add', id: 'LOT-2025-0003', attrs: attrs('finished') },
  ]);
  g.applyTransaction([{ op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' }]);
  g.undo();
  g.applyTransaction([{ op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0003' }]);
  assert.throws(() => g.redo(), /nothing to redo/);
});

test('undo of a multi-command transaction rolls back all of it', () => {
  const g = baseGraph();
  g.applyTransaction([
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' },
    { op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0003' },
  ]);
  g.undo();
  assert.deepEqual(g.descendants('LOT-2025-0001'), []);
  assert.deepEqual(g.ancestors('LOT-2025-0003'), []);
});

test('serialization round-trips and keeps version and command hash', () => {
  const g = baseGraph();
  g.applyTransaction([{ op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' }]);
  const restored = LineageGraph.fromJSON(g.toJSON());
  assert.equal(restored.version, g.version);
  assert.equal(restored.commandHash(), g.commandHash());
  assert.deepEqual(restored.descendants('LOT-2025-0001'), ['LOT-2025-0002']);
});

test('shortestPath returns deterministic shortest path or null', () => {
  const g = baseGraph();
  g.applyTransaction([{ op: 'add', id: 'LOT-2025-0004', attrs: attrs('finished') }]);
  g.applyTransaction([
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' },
    { op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0003' },
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0003' },
  ]);
  assert.deepEqual(g.shortestPath('LOT-2025-0001', 'LOT-2025-0003'), ['LOT-2025-0001', 'LOT-2025-0003']);
  assert.equal(g.shortestPath('LOT-2025-0003', 'LOT-2025-0004'), null);
});
