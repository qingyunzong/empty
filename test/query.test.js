import test from 'node:test';
import assert from 'node:assert/strict';
import { LineageGraph } from '../src/graph.js';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { run } from '../src/vm.js';

function buildGraph() {
  const g = new LineageGraph();
  g.applyTransaction([
    { op: 'add', id: 'LOT-2025-0001', type: 'raw_material', props: { name: 'Flour', date: '2025-01-05', quantity: 100 } },
    { op: 'add', id: 'LOT-2025-0002', type: 'raw_material', props: { name: 'Sugar', date: '2025-01-06', quantity: 50 } },
    { op: 'add', id: 'LOT-2025-0003', type: 'intermediate', props: { name: 'Dough A', date: '2025-01-10' } },
    { op: 'add', id: 'LOT-2025-0004', type: 'intermediate', props: { name: 'Dough B', date: '2025-01-11' } },
    { op: 'add', id: 'LOT-2025-0005', type: 'product', props: { name: 'Bread', date: '2025-01-15' } },
  ]);
  g.applyTransaction([
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0003' },
    { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0004' },
    { op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0004' },
    { op: 'link', from: 'LOT-2025-0003', to: 'LOT-2025-0005' },
    { op: 'link', from: 'LOT-2025-0004', to: 'LOT-2025-0005' },
  ]);
  return g;
}

const query = (g, src) => run(compile(parse(src)), g);

test('ancestors query with filter and ordering', () => {
  const g = buildGraph();
  const [out] = query(g, `
    let base = ancestors(LOT-2025-0005);
    base where type == "raw_material" and date >= 2025-01-06 order by id desc;
  `);
  assert.deepEqual(out, { kind: 'set', ids: ['LOT-2025-0002'] });
});

test('descendants of a shared raw material', () => {
  const g = buildGraph();
  const [out] = query(g, 'descendants(LOT-2025-0001);');
  assert.deepEqual(out.ids, ['LOT-2025-0003', 'LOT-2025-0004', 'LOT-2025-0005']);
});

test('shortestPath emits a path', () => {
  const g = buildGraph();
  const [out] = query(g, 'shortestPath(LOT-2025-0002, LOT-2025-0005);');
  assert.deepEqual(out, { kind: 'path', ids: ['LOT-2025-0002', 'LOT-2025-0004', 'LOT-2025-0005'] });
});

test('lexical scoping: inner let shadows outer, outer restored after block', () => {
  const g = buildGraph();
  const [inner, outer] = query(g, `
    let x = ancestors(LOT-2025-0004);
    { let x = ancestors(LOT-2025-0003); x; }
    x;
  `);
  assert.deepEqual(inner.ids, ['LOT-2025-0001']);
  assert.deepEqual(outer.ids, ['LOT-2025-0001', 'LOT-2025-0002']);
});

test('default ordering is by id ascending', () => {
  const g = buildGraph();
  const [out] = query(g, 'ancestors(LOT-2025-0005);');
  assert.deepEqual(out.ids, ['LOT-2025-0001', 'LOT-2025-0002', 'LOT-2025-0003', 'LOT-2025-0004']);
});

test('numeric and string comparisons in filters', () => {
  const g = buildGraph();
  const [out] = query(g, 'nodes() where type == "raw_material" and quantity > 60;');
  assert.deepEqual(out.ids, ['LOT-2025-0001']);
  const [byName] = query(g, 'nodes() where name == "Sugar";');
  assert.deepEqual(byName.ids, ['LOT-2025-0002']);
});
