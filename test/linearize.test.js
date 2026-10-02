// Acceptance 1: a linearizable log yields the unique causal order, and the
// result is cross-checked by enumerating all topological orders of the
// precedence DAG built independently from vector clocks + time windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Solver } from '../src/solver.js';
import { compareVC } from '../src/vclock.js';

const WINDOW = 5;
const EVENTS = [
  { id: 'a1', device: 'A', ts: 0, vc: { A: 1 }, type: 'RUN' },
  { id: 'b1', device: 'B', ts: 6, vc: { B: 1 }, type: 'RUN' },
  { id: 'a2', device: 'A', ts: 12, vc: { A: 2 }, type: 'STOP' },
  { id: 'b2', device: 'B', ts: 18, vc: { A: 2, B: 2 }, type: 'RESET' },
];

function enumerateTopoOrders(ids, edges) {
  const preds = new Map(ids.map((id) => [id, new Set()]));
  for (const [x, y] of edges) preds.get(y).add(x);
  const results = [];
  const used = new Set();
  const path = [];
  (function dfs() {
    if (path.length === ids.length) {
      results.push([...path]);
      return;
    }
    for (const id of ids) {
      if (used.has(id)) continue;
      if ([...preds.get(id)].some((p) => !used.has(p))) continue;
      used.add(id);
      path.push(id);
      dfs();
      path.pop();
      used.delete(id);
    }
  })();
  return results;
}

test('linearizable log: unique causal order, verified by topo-order enumeration', () => {
  const solver = new Solver({ window: WINDOW });
  for (const e of EVENTS) solver.addEvent(e);
  const res = solver.solve({ budget: 100 });

  assert.equal(res.status, 'feasible');
  assert.equal(res.unique, true);
  assert.deepEqual(res.order, ['a1', 'b1', 'a2', 'b2']);
  assert.deepEqual(res.positions, { a1: 0, b1: 1, a2: 2, b2: 3 });

  // Independent cross-check: rebuild the DAG from vc + window only.
  const edges = [];
  for (const x of EVENTS) {
    for (const y of EVENTS) {
      if (x.id === y.id) continue;
      if (compareVC(x.vc, y.vc) === 'lt' || x.ts + WINDOW <= y.ts) edges.push([x.id, y.id]);
    }
  }
  const topoOrders = enumerateTopoOrders(EVENTS.map((e) => e.id), edges);
  assert.equal(topoOrders.length, 1, 'DAG must admit exactly one topological order');
  assert.deepEqual(res.order, topoOrders[0]);
});
