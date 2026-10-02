import test from 'node:test';
import assert from 'node:assert/strict';
import { LineageGraph, GraphError } from '../src/graph.js';

const add = (id, type) => ({ op: 'add', id, type });
const link = (from, to) => ({ op: 'link', from, to });

function sampleGraph() {
  const g = new LineageGraph();
  g.applyTransaction([
    add('LOT-2025-0001', 'raw_material'),
    add('LOT-2025-0002', 'raw_material'),
    add('LOT-2025-0003', 'intermediate'),
    add('LOT-2025-0004', 'intermediate'),
    add('LOT-2025-0005', 'product'),
  ]);
  g.applyTransaction([
    link('LOT-2025-0001', 'LOT-2025-0003'),
    link('LOT-2025-0001', 'LOT-2025-0004'),
    link('LOT-2025-0002', 'LOT-2025-0004'),
    link('LOT-2025-0003', 'LOT-2025-0005'),
    link('LOT-2025-0004', 'LOT-2025-0005'),
  ]);
  return g;
}

test('add/link/unlink and traversal basics', () => {
  const g = sampleGraph();
  assert.deepEqual(g.ancestorsOf(['LOT-2025-0005']).sort(),
    ['LOT-2025-0001', 'LOT-2025-0002', 'LOT-2025-0003', 'LOT-2025-0004']);
  assert.deepEqual(g.descendantsOf(['LOT-2025-0001']).sort(),
    ['LOT-2025-0003', 'LOT-2025-0004', 'LOT-2025-0005']);
  g.applyTransaction([{ op: 'unlink', from: 'LOT-2025-0001', to: 'LOT-2025-0004' }]);
  assert.deepEqual(g.descendantsOf(['LOT-2025-0001']).sort(),
    ['LOT-2025-0003', 'LOT-2025-0005']);
});

test('cycle-creating link is rejected and transaction is atomic', () => {
  const g = sampleGraph();
  const before = JSON.stringify(g.toJSON());
  assert.throws(() => g.applyTransaction([
    link('LOT-2025-0002', 'LOT-2025-0003'),   // valid on its own
    link('LOT-2025-0005', 'LOT-2025-0003'),   // invalid: product -> intermediate
  ]), GraphError);
  assert.throws(() => g.applyTransaction([
    link('LOT-2025-0005', 'LOT-2025-0001'),   // would need schema-legal types; use intermediates instead
  ]));
  // direct cycle among intermediates
  const g2 = new LineageGraph();
  g2.applyTransaction([
    add('LOT-2025-0001', 'raw_material'),
    add('LOT-2025-0002', 'intermediate'),
    add('LOT-2025-0003', 'intermediate'),
  ]);
  g2.applyTransaction([link('LOT-2025-0001', 'LOT-2025-0002'), link('LOT-2025-0002', 'LOT-2025-0003')]);
  const snap = JSON.stringify(g2.toJSON());
  assert.throws(() => g2.applyTransaction([link('LOT-2025-0003', 'LOT-2025-0002')]), /cycle/);
  assert.equal(JSON.stringify(g2.toJSON()), snap); // no partial write
  assert.equal(JSON.stringify(g.toJSON()), before);
});

test('undo/redo restores lineage and bumps version', () => {
  const g = sampleGraph();
  const v = g.version;
  g.applyTransaction([link('LOT-2025-0002', 'LOT-2025-0003')]);
  assert.ok(g.ancestorsOf(['LOT-2025-0003']).includes('LOT-2025-0002'));
  g.undo();
  assert.ok(!g.ancestorsOf(['LOT-2025-0003']).includes('LOT-2025-0002'));
  assert.equal(g.version, v + 2);
  g.redo();
  assert.ok(g.ancestorsOf(['LOT-2025-0003']).includes('LOT-2025-0002'));
  assert.equal(g.version, v + 3);
});

test('state round-trips through JSON', () => {
  const g = sampleGraph();
  const restored = LineageGraph.load(JSON.parse(JSON.stringify(g.toJSON())));
  assert.deepEqual(restored.ancestorsOf(['LOT-2025-0005']).sort(),
    g.ancestorsOf(['LOT-2025-0005']).sort());
  assert.equal(restored.version, g.version);
});

test('schema validation rejects bad types and props', () => {
  const g = new LineageGraph();
  assert.throws(() => g.applyTransaction([add('LOT-2025-0001', 'alien')]), /unknown node type/);
  assert.throws(() => g.applyTransaction([
    { op: 'add', id: 'LOT-2025-0001', type: 'raw_material', props: { color: 'red' } },
  ]), /unknown property/);
  assert.throws(() => g.applyTransaction([add('not-a-lot', 'raw_material')]), /id must look like/);
});
