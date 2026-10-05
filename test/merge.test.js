import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistories, applyOrder, matrixToObject } from '../src/merge.js';
import { parseHistories, unwindUndos, pairSyncs, validateConfig } from '../src/history.js';
import { buildGraph, transitiveClosure, allTopoOrders } from '../src/graph.js';
import { Budget } from '../src/errors.js';
import { CONFIG, lines } from './helpers.js';

const THREE_DEVICE = [
  {
    name: 'A',
    text: lines(
      { id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 2 },
      { id: 'a2', device: 'A', ts: 2, op: 'sync', with: 'B', mark: 'm1' },
      { id: 'a3', device: 'A', ts: 3, op: 'set_count', plot: 'P2', species: 'G1', tier: 1 }
    ),
  },
  {
    name: 'B',
    text: lines(
      { id: 'b1', device: 'B', ts: 1, op: 'set_count', plot: 'P1', species: 'S2', tier: 3 },
      { id: 'b2', device: 'B', ts: 2, op: 'sync', with: 'A', mark: 'm1' },
      { id: 'b3', device: 'B', ts: 3, op: 'sync', with: 'C', mark: 'm2' }
    ),
  },
  {
    name: 'C',
    text: lines(
      { id: 'c1', device: 'C', ts: 1, op: 'set_count', plot: 'P2', species: 'S1', tier: 1 },
      { id: 'c2', device: 'C', ts: 2, op: 'sync', with: 'B', mark: 'm2' }
    ),
  },
];

test('acceptance 1: three-device merge matches a legal serialization', () => {
  const result = mergeHistories(CONFIG, THREE_DEVICE);
  assert.equal(result.verdict, 'CONCURRENT_OK');
  assert.deepEqual(result.matrix, {
    P1: { S1: 2, S2: 3, G1: 0 },
    P2: { S1: 1, S2: 0, G1: 1 },
  });

  // Independently enumerate every legal serialization (topological order of
  // the happens-before graph) and confirm the merged matrix is one of them.
  const domain = validateConfig(CONFIG);
  const eff = unwindUndos(parseHistories(THREE_DEVICE, domain));
  const pairs = pairSyncs(eff);
  const ops = [...eff.values()].flat();
  const opsById = new Map(ops.map((o) => [o.id, o]));
  const adj = buildGraph(ops, pairs);
  const budget = new Budget();
  const reach = transitiveClosure(adj, budget);
  const hb = (a, b) => reach.get(a)?.has(b) ?? false;
  const serializations = new Set();
  for (const order of allTopoOrders(adj)) {
    serializations.add(JSON.stringify(matrixToObject(applyOrder(order, opsById, domain, [], hb))));
  }
  assert.ok(serializations.has(JSON.stringify(result.matrix)),
    'merged matrix must equal at least one legal serialization');
  assert.equal(serializations.size, 1, 'all legal serializations agree (convergence)');
});

test('LINEARIZABLE_MODEL when syncs totally order all writes', () => {
  const inputs = [
    {
      name: 'A',
      text: lines(
        { id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 2 },
        { id: 'a2', device: 'A', ts: 2, op: 'sync', with: 'B', mark: 'm1' }
      ),
    },
    {
      name: 'B',
      text: lines(
        { id: 'b1', device: 'B', ts: 1, op: 'sync', with: 'A', mark: 'm1' },
        { id: 'b2', device: 'B', ts: 2, op: 'set_count', plot: 'P1', species: 'S1', tier: 4 }
      ),
    },
  ];
  const result = mergeHistories(CONFIG, inputs);
  assert.equal(result.verdict, 'LINEARIZABLE_MODEL');
  assert.equal(result.matrix.P1.S1, 4); // b2 causally overwrites a1
});

test('concurrent identical writes converge (CONCURRENT_OK)', () => {
  const inputs = [
    { name: 'A', text: lines({ id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 3 }) },
    { name: 'B', text: lines({ id: 'b1', device: 'B', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 3 }) },
  ];
  const result = mergeHistories(CONFIG, inputs);
  assert.equal(result.verdict, 'CONCURRENT_OK');
  assert.equal(result.matrix.P1.S1, 3);
});

test('morph_species propagates across histories but spares synced facts', () => {
  const inputs = [
    {
      name: 'A',
      text: lines(
        { id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 2 },
        { id: 'a2', device: 'A', ts: 2, op: 'morph_species', from: 'S1', to: 'S2' },
        { id: 'a3', device: 'A', ts: 3, op: 'set_count', plot: 'P2', species: 'S1', tier: 3 },
        { id: 'a4', device: 'A', ts: 4, op: 'sync', with: 'B', mark: 'm1' }
      ),
    },
    {
      name: 'B',
      text: lines(
        { id: 'b1', device: 'B', ts: 1, op: 'sync', with: 'A', mark: 'm1' },
        { id: 'b2', device: 'B', ts: 2, op: 'set_count', plot: 'P1', species: 'S1', tier: 4 }
      ),
    },
  ];
  const result = mergeHistories(CONFIG, inputs);
  // a1's unsynced S1 fact is renamed to S2; a3 and b2 happen-after the morph
  // so their S1 references resolve to S2 as well.
  assert.deepEqual(result.matrix, {
    P1: { S1: 0, S2: 4, G1: 0 },
    P2: { S1: 0, S2: 3, G1: 0 },
  });
});

test('morph_species does not rewrite already-synced facts', () => {
  const inputs = [
    {
      name: 'A',
      text: lines(
        { id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 2 },
        { id: 'a2', device: 'A', ts: 2, op: 'sync', with: 'B', mark: 'm1' },
        { id: 'a3', device: 'A', ts: 3, op: 'morph_species', from: 'S1', to: 'S2' },
        { id: 'a4', device: 'A', ts: 4, op: 'sync', with: 'B', mark: 'm2' }
      ),
    },
    {
      name: 'B',
      text: lines(
        { id: 'b0', device: 'B', ts: 0, op: 'set_count', plot: 'P2', species: 'S1', tier: 1 },
        { id: 'b1', device: 'B', ts: 1, op: 'sync', with: 'A', mark: 'm1' },
        { id: 'b2', device: 'B', ts: 2, op: 'sync', with: 'A', mark: 'm2' },
        { id: 'b3', device: 'B', ts: 3, op: 'set_count', plot: 'P1', species: 'S2', tier: 5 }
      ),
    },
  ];
  const result = mergeHistories(CONFIG, inputs);
  // Both S1 facts were synced before the morph: names are preserved.
  assert.deepEqual(result.matrix, {
    P1: { S1: 2, S2: 5, G1: 0 },
    P2: { S1: 1, S2: 0, G1: 0 },
  });
});

test('undo_op retracts the latest unsynced op', () => {
  const inputs = [
    {
      name: 'A',
      text: lines(
        { id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 2 },
        { id: 'a2', device: 'A', ts: 2, op: 'undo_op', target: 'a1' },
        { id: 'a3', device: 'A', ts: 3, op: 'set_count', plot: 'P1', species: 'S1', tier: 1 }
      ),
    },
  ];
  const result = mergeHistories(CONFIG, inputs);
  assert.equal(result.matrix.P1.S1, 1);
});

test('move_plot conserves total abundance within a plot', () => {
  const inputs = [
    {
      name: 'A',
      text: lines(
        { id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 4 },
        { id: 'a2', device: 'A', ts: 2, op: 'move_plot', plot: 'P1', from: 'S1', to: 'S2', count: 3 }
      ),
    },
  ];
  const result = mergeHistories(CONFIG, inputs);
  assert.equal(result.matrix.P1.S1, 1);
  assert.equal(result.matrix.P1.S2, 3);
});
