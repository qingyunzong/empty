import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCirculation } from '../src/circulation.js';

function assertConservation(nodes, edges, flow) {
  for (const node of nodes) {
    let inflow = 0;
    let outflow = 0;
    for (const edge of edges) {
      if (edge.to === node) inflow += flow[edge.id];
      if (edge.from === node) outflow += flow[edge.id];
    }
    assert.equal(inflow, outflow, `node ${node} must be balanced`);
  }
}

test('acceptance 1: simple cycle is feasible and lower bounds are satisfied', () => {
  const nodes = ['A', 'B', 'C'];
  const edges = [
    { id: 'e1', from: 'A', to: 'B', lower: 2, upper: 5 },
    { id: 'e2', from: 'B', to: 'C', lower: 1, upper: 4 },
    { id: 'e3', from: 'C', to: 'A', lower: 1, upper: 4 },
  ];
  const result = checkCirculation(nodes, edges);
  assert.equal(result.feasible, true);
  for (const edge of edges) {
    const value = result.flow[edge.id];
    assert.ok(Number.isInteger(value), 'settlement amounts are integers');
    assert.ok(value >= edge.lower, `${edge.id} meets its lower bound`);
    assert.ok(value <= edge.upper, `${edge.id} respects its upper bound`);
  }
  assertConservation(nodes, edges, result.flow);
});

test('acceptance 2: external imbalance is infeasible, returns certificate and no pseudo flow', () => {
  const nodes = ['A', 'B'];
  const edges = [{ id: 'e1', from: 'A', to: 'B', lower: 5, upper: 10 }];
  const result = checkCirculation(nodes, edges);
  assert.equal(result.feasible, false);
  assert.equal('flow' in result, false, 'no pseudo flow is produced');
  assert.deepEqual(result.deficitNodes, ['B']);
  const { cut, lowerBoundIn, upperBoundOut, deficit } = result.certificate;
  assert.deepEqual(cut, ['B']);
  assert.equal(lowerBoundIn, 5);
  assert.equal(upperBoundOut, 0);
  assert.equal(deficit, 5);
  assert.ok(deficit > 0, 'certificate is a genuinely violated cut');
});

test('empty graph is feasible with empty flow', () => {
  assert.deepEqual(checkCirculation([], []), { feasible: true, flow: {} });
});

test('self-loop lower bound is satisfiable', () => {
  const result = checkCirculation(['A'], [{ id: 'loop', from: 'A', to: 'A', lower: 3, upper: 7 }]);
  assert.equal(result.feasible, true);
  assert.equal(result.flow.loop, 3);
});

test('parallel edges are supported', () => {
  const nodes = ['A', 'B'];
  const edges = [
    { id: 'x1', from: 'A', to: 'B', lower: 2, upper: 2 },
    { id: 'x2', from: 'B', to: 'A', lower: 1, upper: 1 },
    { id: 'x3', from: 'B', to: 'A', lower: 1, upper: 1 },
  ];
  const result = checkCirculation(nodes, edges);
  assert.equal(result.feasible, true);
  assertConservation(nodes, edges, result.flow);
});

test('certificate cut matches Hoffman violation on a richer infeasible graph', () => {
  const nodes = ['A', 'B', 'C', 'D'];
  const edges = [
    { id: 'ab', from: 'A', to: 'B', lower: 4, upper: 9 },
    { id: 'ac', from: 'A', to: 'C', lower: 0, upper: 3 },
    { id: 'cb', from: 'C', to: 'B', lower: 2, upper: 5 },
    { id: 'bd', from: 'B', to: 'D', lower: 0, upper: 1 },
    { id: 'cd', from: 'C', to: 'D', lower: 0, upper: 1 },
    { id: 'da', from: 'D', to: 'A', lower: 0, upper: 10 },
  ];
  const result = checkCirculation(nodes, edges);
  assert.equal(result.feasible, false);
  const { cut, lowerBoundIn, upperBoundOut, deficit } = result.certificate;
  const inCut = new Set(cut);
  let expectIn = 0;
  let expectOut = 0;
  for (const e of edges) {
    if (inCut.has(e.to) && !inCut.has(e.from)) expectIn += e.lower;
    if (inCut.has(e.from) && !inCut.has(e.to)) expectOut += e.upper;
  }
  assert.equal(lowerBoundIn, expectIn);
  assert.equal(upperBoundOut, expectOut);
  assert.equal(deficit, expectIn - expectOut);
  assert.ok(deficit > 0);
  assert.deepEqual(result.deficitNodes, cut);
});
