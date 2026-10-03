'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { solveCirculation } = require('../index');
const {
  subsetCutFeasible,
  bruteForceFeasible,
  assertValidCirculation,
  mulberry32,
  randomGraph,
} = require('./helpers');

test('simple cycle is feasible and lower bounds are satisfied', () => {
  const edges = [
    { from: 'A', to: 'B', lower: 2, upper: 5 },
    { from: 'B', to: 'C', lower: 1, upper: 4 },
    { from: 'C', to: 'A', lower: 3, upper: 6 },
  ];
  const result = solveCirculation(edges);
  assert.equal(result.feasible, true);
  assertValidCirculation(assert, edges, result.flows);
});

test('empty network is trivially feasible', () => {
  const result = solveCirculation([]);
  assert.deepEqual(result, { feasible: true, flows: {} });
});

test('external imbalance is infeasible: certificate returned, no pseudo-flow', () => {
  const edges = [{ from: 'A', to: 'B', lower: 5, upper: 10 }];
  const result = solveCirculation(edges);
  assert.equal(result.feasible, false);
  assert.ok(!('flows' in result), 'infeasible result must not carry flows');
  assert.deepEqual(result.deficits, [{ node: 'B', amount: 5 }]);
  assert.deepEqual(result.cut, { nodes: ['A'], lowerOut: 5, upperIn: 0, violation: 5 });
  assert.ok(result.cut.violation > 0);
});

test('certificate cut always witnesses a Hoffmann violation', () => {
  const edges = [
    { from: 'A', to: 'B', lower: 4, upper: 9 },
    { from: 'B', to: 'C', lower: 0, upper: 2 },
    { from: 'C', to: 'A', lower: 0, upper: 1 },
  ];
  const result = solveCirculation(edges);
  assert.equal(result.feasible, false);
  const cutSet = new Set(result.cut.nodes);
  let lowerOut = 0;
  let upperIn = 0;
  for (const e of edges) {
    const fi = cutSet.has(e.from);
    const ti = cutSet.has(e.to);
    if (fi && !ti) lowerOut += e.lower;
    if (!fi && ti) upperIn += e.upper;
  }
  assert.equal(result.cut.lowerOut, lowerOut);
  assert.equal(result.cut.upperIn, upperIn);
  assert.ok(lowerOut > upperIn, 'reported cut must violate the cut condition');
  assert.ok(result.deficits.length > 0);
  for (const d of result.deficits) assert.ok(d.amount > 0);
});

test('random small graphs: solver matches subset-cut criterion and brute force', () => {
  const rand = mulberry32(20261003);
  let bruteChecked = 0;
  for (let iter = 0; iter < 400; iter += 1) {
    const { nodes, edges } = randomGraph(rand, { maxNodes: 7, maxUpper: 10 });
    const result = solveCirculation(edges);
    const expected = subsetCutFeasible(nodes, edges);
    assert.equal(
      result.feasible,
      expected,
      `subset-cut mismatch on ${JSON.stringify(edges)}`,
    );
    const brute = bruteForceFeasible(nodes, edges);
    if (brute !== null) {
      bruteChecked += 1;
      assert.equal(result.feasible, brute, `brute-force mismatch on ${JSON.stringify(edges)}`);
    }
    if (result.feasible) {
      assertValidCirculation(assert, edges, result.flows);
    } else {
      assert.ok(!('flows' in result));
      assert.ok(result.cut.violation > 0);
      assert.ok(result.deficits.length > 0);
    }
  }
  assert.ok(bruteChecked > 100, `expected ample brute-force coverage, got ${bruteChecked}`);
});
