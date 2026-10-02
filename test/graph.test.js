import test from 'node:test';
import assert from 'node:assert/strict';
import { Budget, kahn, minimalCycle, ancestorsOf } from '../src/index.js';

function chainAdj(n) {
  const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
  const adj = new Map(nodes.map((id) => [id, new Set()]));
  for (let i = 1; i < n; i++) adj.get(`n${i - 1}`).add(`n${i}`);
  return { nodes, adj };
}

test('kahn sorts a chain and reports a unique order', () => {
  const { nodes, adj } = chainAdj(5);
  const r = kahn(nodes, adj, new Budget(1000));
  assert.deepEqual(r.order, nodes);
  assert.equal(r.unique, true);
});

test('kahn reports branching (non-unique order) on a diamond', () => {
  const nodes = ['a', 'b', 'c', 'd'];
  const adj = new Map(nodes.map((n) => [n, new Set()]));
  adj.get('a').add('b');
  adj.get('a').add('c');
  adj.get('b').add('d');
  adj.get('c').add('d');
  const r = kahn(nodes, adj, new Budget(1000));
  assert.equal(r.unique, false);
  assert.deepEqual(r.order, ['a', 'b', 'c', 'd']);
});

test('kahn exposes the cyclic remainder', () => {
  const nodes = ['a', 'b', 'c', 'd'];
  const adj = new Map(nodes.map((n) => [n, new Set()]));
  adj.get('a').add('b');
  adj.get('b').add('c');
  adj.get('c').add('a');
  adj.get('c').add('d');
  const r = kahn(nodes, adj, new Budget(1000));
  assert.deepEqual(new Set(r.remaining), new Set(['a', 'b', 'c', 'd']));
});

test('kahn returns pending when the budget runs out', () => {
  const { nodes, adj } = chainAdj(10);
  const r = kahn(nodes, adj, new Budget(1));
  assert.equal(r.pending, true);
});

test('minimalCycle finds the shortest cycle', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'];
  const adj = new Map(nodes.map((n) => [n, new Set()]));
  adj.get('a').add('b');
  adj.get('b').add('c');
  adj.get('c').add('a'); // triangle
  adj.get('d').add('a');
  adj.get('c').add('e');
  adj.get('e').add('e'); // self loop
  const r = minimalCycle(adj, nodes, new Budget(1000));
  assert.deepEqual(r.cycle, ['e']);
});

test('minimalCycle respects the budget', () => {
  const { nodes, adj } = chainAdj(50);
  adj.get('n49').add('n0');
  const r = minimalCycle(adj, nodes, new Budget(3));
  assert.equal(r.pending, true);
});

test('ancestorsOf computes strict ancestry', () => {
  const { nodes, adj } = chainAdj(4);
  const anc = ancestorsOf(nodes, adj);
  assert.deepEqual([...anc.get('n3')].sort(), ['n0', 'n1', 'n2']);
  assert.equal(anc.get('n0').size, 0);
});
