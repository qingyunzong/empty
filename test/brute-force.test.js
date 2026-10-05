import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCirculation } from '../src/circulation.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Independent oracle: enumerate every integer assignment in [lower, upper]
 * per edge with balance-based pruning, and check node conservation.
 */
function bruteForceFeasible(nodes, edges) {
  const index = new Map(nodes.map((name, i) => [name, i]));
  const balance = new Array(nodes.length).fill(0);
  const m = edges.length;

  const remainingCanFix = (k) => {
    for (let v = 0; v < nodes.length; v++) {
      let min = 0;
      let max = 0;
      for (let j = k; j < m; j++) {
        const e = edges[j];
        if (index.get(e.to) === v) { min += e.lower; max += e.upper; }
        if (index.get(e.from) === v) { min -= e.upper; max -= e.lower; }
      }
      if (balance[v] + min > 0 || balance[v] + max < 0) return false;
    }
    return true;
  };

  const search = (k) => {
    if (k === m) return balance.every((b) => b === 0);
    const e = edges[k];
    const u = index.get(e.from);
    const v = index.get(e.to);
    for (let f = e.lower; f <= e.upper; f++) {
      balance[v] += f;
      balance[u] -= f;
      if (remainingCanFix(k + 1) && search(k + 1)) return true;
      balance[v] -= f;
      balance[u] += f;
    }
    return false;
  };

  return search(0);
}

function validateFlow(nodes, edges, flow) {
  for (const e of edges) {
    const value = flow[e.id];
    assert.ok(Number.isInteger(value), `flow on ${e.id} is an integer`);
    assert.ok(value >= e.lower && value <= e.upper, `flow on ${e.id} within [${e.lower}, ${e.upper}]`);
  }
  for (const node of nodes) {
    let inflow = 0;
    let outflow = 0;
    for (const e of edges) {
      if (e.to === node) inflow += flow[e.id];
      if (e.from === node) outflow += flow[e.id];
    }
    assert.equal(inflow, outflow, `node ${node} balanced`);
  }
}

function validateCertificate(edges, result) {
  assert.equal('flow' in result, false, 'infeasible result carries no pseudo flow');
  const { cut, lowerBoundIn, upperBoundOut, deficit } = result.certificate;
  const inCut = new Set(cut);
  let expectIn = 0;
  let expectOut = 0;
  for (const e of edges) {
    if (inCut.has(e.to) && !inCut.has(e.from)) expectIn += e.lower;
    if (inCut.has(e.from) && !inCut.has(e.to)) expectOut += e.upper;
  }
  assert.equal(lowerBoundIn, expectIn, 'certificate lowerBoundIn matches the cut');
  assert.equal(upperBoundOut, expectOut, 'certificate upperBoundOut matches the cut');
  assert.equal(deficit, expectIn - expectOut);
  assert.ok(deficit > 0, 'certificate cut is genuinely violated');
  assert.deepEqual(result.deficitNodes, cut);
}

test('random small graphs (n<=7, capacity<=10) match brute-force enumeration', () => {
  const rand = mulberry32(20261005);
  const TRIALS = 400;
  let feasibleCount = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    const n = 2 + Math.floor(rand() * 6); // 2..7 nodes
    const nodes = Array.from({ length: n }, (_, i) => `N${i}`);
    const m = 1 + Math.floor(rand() * 8); // 1..8 edges
    const edges = [];
    for (let j = 0; j < m; j++) {
      const from = nodes[Math.floor(rand() * n)];
      const to = nodes[Math.floor(rand() * n)];
      const upper = Math.floor(rand() * 11); // 0..10
      const lower = Math.floor(rand() * (upper + 1));
      edges.push({ id: `e${j}`, from, to, lower, upper });
    }

    const result = checkCirculation(nodes, edges);
    const expected = bruteForceFeasible(nodes, edges);
    assert.equal(
      result.feasible,
      expected,
      `trial ${trial}: feasibility mismatch on ${JSON.stringify(edges)}`,
    );
    if (result.feasible) {
      feasibleCount++;
      validateFlow(nodes, edges, result.flow);
    } else {
      validateCertificate(edges, result);
    }
  }
  assert.ok(feasibleCount > 0, 'random suite covers feasible instances');
  assert.ok(feasibleCount < TRIALS, 'random suite covers infeasible instances');
});

test('dense random graphs near the enumeration limit also match', () => {
  const rand = mulberry32(777);
  for (let trial = 0; trial < 60; trial++) {
    const n = 7;
    const nodes = Array.from({ length: n }, (_, i) => `N${i}`);
    const m = 9;
    const edges = [];
    for (let j = 0; j < m; j++) {
      const from = nodes[Math.floor(rand() * n)];
      let to = nodes[Math.floor(rand() * n)];
      const upper = 1 + Math.floor(rand() * 10); // 1..10
      const lower = Math.floor(rand() * (upper + 1));
      edges.push({ id: `e${j}`, from, to, lower, upper });
    }
    const result = checkCirculation(nodes, edges);
    assert.equal(result.feasible, bruteForceFeasible(nodes, edges),
      `trial ${trial}: mismatch on ${JSON.stringify(edges)}`);
    if (result.feasible) validateFlow(nodes, edges, result.flow);
    else validateCertificate(edges, result);
  }
});
