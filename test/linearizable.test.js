// Acceptance 1: a linearizable log yields the unique causal order,
// cross-checked by independently enumerating all topological orders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store.js';
import { PrecedenceEngine } from '../src/engine.js';
import { solve } from '../src/solver.js';
import { enumerateTopoOrders } from '../testkit/helpers.js';

// Two devices; vector clocks force a single interleaving:
//   e1(d1 RUN) < e4(d2 RUN) < e2(d1 STOP) < e5(d2 STOP) < e3(d1 RESET)
const EVENTS = [
  { id: 'e1', device: 'd1', ts: 1000, vc: { d1: 1 }, type: 'RUN' },
  { id: 'e4', device: 'd2', ts: 1001, vc: { d1: 1, d2: 1 }, type: 'RUN' },
  { id: 'e2', device: 'd1', ts: 1002, vc: { d1: 2, d2: 1 }, type: 'STOP' },
  { id: 'e5', device: 'd2', ts: 1003, vc: { d1: 2, d2: 2 }, type: 'STOP' },
  { id: 'e3', device: 'd1', ts: 1004, vc: { d1: 3, d2: 2 }, type: 'RESET' },
];

test('linearizable log: unique causal order, verified by topo-order enumeration', () => {
  const store = new EventStore();
  // Insert out of order to simulate delayed / reordered delivery.
  for (const e of [EVENTS[3], EVENTS[0], EVENTS[4], EVENTS[1], EVENTS[2]]) store.add(e);

  const result = solve(store, { budget: 1000 });
  assert.equal(result.status, 'sat');
  assert.equal(result.unique, true);
  assert.deepEqual(result.order, ['e1', 'e4', 'e2', 'e5', 'e3']);
  assert.deepEqual(result.positions, { e1: 0, e4: 1, e2: 2, e5: 3, e3: 4 });

  // Independent check: enumerate every topological order of the propagated DAG.
  const engine = new PrecedenceEngine({});
  for (const e of store.list()) engine.addEvent(e);
  const edges = [...engine.edges()].map((edge) => [edge.from, edge.to]);
  const allOrders = enumerateTopoOrders(store.list().map((e) => e.id), edges);
  assert.equal(allOrders.length, 1);
  assert.deepEqual(allOrders[0], result.order);
});

test('time window propagates precedence beyond vector clocks', () => {
  const store = new EventStore();
  // Concurrent vector clocks, but timestamps differ by more than maxSkewMs.
  store.add({ id: 'a', device: 'd1', ts: 0, vc: { d1: 1 }, type: 'RUN' });
  store.add({ id: 'b', device: 'd2', ts: 100000, vc: { d2: 1 }, type: 'RUN' });
  const result = solve(store, { budget: 100, maxSkewMs: 30000 });
  assert.equal(result.status, 'sat');
  assert.equal(result.unique, true);
  assert.deepEqual(result.order, ['a', 'b']);
});

test('empty store is trivially sat with a unique empty order', () => {
  const result = solve(new EventStore(), { budget: 10 });
  assert.equal(result.status, 'sat');
  assert.equal(result.unique, true);
  assert.deepEqual(result.order, []);
});
