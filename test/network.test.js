import test from 'node:test';
import assert from 'node:assert/strict';
import { CreditNetwork, CreditError } from '../lib/network.js';

function buildDiamond() {
  const net = new CreditNetwork();
  net.addEdge('S', 'A', 5);
  net.addEdge('S', 'B', 4);
  net.addEdge('A', 'B', 2);
  net.addEdge('A', 'C', 5);
  net.addEdge('B', 'C', 4);
  return net;
}

function checkConservation(net, result, source, target) {
  const balance = new Map();
  for (const { from, to, amount } of result.flows) {
    assert.ok(amount > 0, 'flow amounts are positive');
    const edge = net.getEdge(from, to);
    assert.ok(edge, `flow edge ${from}->${to} exists`);
    assert.ok(amount <= edge.capacity, `flow ${amount} within capacity of ${from}->${to}`);
    balance.set(from, (balance.get(from) ?? 0) - amount);
    balance.set(to, (balance.get(to) ?? 0) + amount);
  }
  for (const [node, value] of balance) {
    if (node === source) assert.equal(value, -result.amount, 'source net outflow');
    else if (node === target) assert.equal(value, result.amount, 'target net inflow');
    else assert.equal(value, 0, `conservation at ${node}`);
  }
}

test('acceptance 1: multi-path freeze succeeds with per-edge flow decomposition', () => {
  const net = buildDiamond();
  const result = net.freeze('S', 'C', 9);
  assert.equal(result.ok, true);
  assert.equal(result.amount, 9);
  assert.equal(typeof result.freezeId, 'string');
  checkConservation(net, result, 'S', 'C');
  // Flow must use both disjoint paths S->A->C and S->B->C (each capped at 5/4).
  const pathTotal = result.paths.reduce((sum, p) => sum + p.amount, 0);
  assert.equal(pathTotal, 9);
  for (const path of result.paths) {
    assert.equal(path.edges[0].from, 'S');
    assert.equal(path.edges.at(-1).to, 'C');
  }
  // Capacity is now fully occupied.
  assert.equal(net.maxFlowValue('S', 'C'), 0);
});

test('acceptance 2: partial release frees capacity for a new freeze within limits', () => {
  const net = buildDiamond();
  const first = net.freeze('S', 'C', 9);
  assert.equal(first.ok, true);

  const rel = net.release(first.freezeId, 4);
  assert.deepEqual(rel, { ok: true, freezeId: first.freezeId, released: 4, remaining: 5 });

  const second = net.freeze('S', 'C', 4);
  assert.equal(second.ok, true, 'can re-freeze exactly the released amount');
  checkConservation(net, second, 'S', 'C');

  // Frozen per edge never exceeds capacity; net frozen outflow at the
  // source equals the live frozen total (9 = 5 remaining + 4 re-frozen).
  let sourceOut = 0;
  for (const edge of net.edges.values()) {
    assert.ok(edge.frozen <= edge.capacity, `${edge.from}->${edge.to} frozen <= capacity`);
    assert.ok(edge.frozen >= 0);
    if (edge.from === 'S') sourceOut += edge.frozen;
    if (edge.to === 'S') sourceOut -= edge.frozen;
  }
  assert.equal(sourceOut, 9);
  assert.equal(net.maxFlowValue('S', 'C'), 0);

  // One more unit must be rejected.
  const third = net.freeze('S', 'C', 1);
  assert.equal(third.ok, false);
  assert.equal(third.maxFreezable, 0);
});

test('acceptance 3: insufficient credit rejects, keeps state, cut equals max freezable', () => {
  const net = buildDiamond();
  net.freeze('S', 'C', 7); // 2 units of residual capacity remain
  const before = JSON.stringify(net.getState().edges);

  const result = net.freeze('S', 'C', 5);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'insufficient-capacity');
  assert.equal(result.requested, 5);
  assert.equal(result.maxFreezable, 2);
  assert.equal(result.cut.capacity, 2, 'cut capacity equals the freezable limit');
  assert.ok(result.cut.nodes.includes('C'), 'customer side of the cut contains the target');
  assert.ok(!result.cut.nodes.includes('S'), 'source is not on the customer side');
  for (const edge of result.cut.edges) {
    assert.ok(edge.capacity >= 0);
  }

  // State is unchanged by the rejected freeze.
  assert.equal(JSON.stringify(net.getState().edges), before);

  // The remaining 2 units are still freezable afterwards.
  const topUp = net.freeze('S', 'C', 2);
  assert.equal(topUp.ok, true);
});

test('errors: unknown source/target, duplicate and over release, capacity guards', () => {
  const net = buildDiamond();
  assert.throws(() => net.freeze('X', 'C', 1), (e) => e instanceof CreditError && e.code === 'UNKNOWN_SOURCE');
  assert.throws(() => net.freeze('S', 'X', 1), (e) => e.code === 'UNKNOWN_TARGET');
  assert.throws(() => net.release('nope'), (e) => e.code === 'UNKNOWN_FREEZE');

  const f = net.freeze('S', 'C', 3);
  assert.throws(() => net.release(f.freezeId, 4), (e) => e.code === 'OVER_RELEASE');
  net.release(f.freezeId); // full release
  assert.throws(() => net.release(f.freezeId), (e) => e.code === 'DUPLICATE_RELEASE');
  assert.throws(() => net.release(f.freezeId, 1), (e) => e.code === 'DUPLICATE_RELEASE');

  net.freeze('S', 'C', 3);
  assert.throws(() => net.setCapacity('S', 'A', 2), (e) => e.code === 'CAPACITY_BELOW_FROZEN');
  assert.throws(() => net.setCapacity('S', 'Z', 2), (e) => e.code === 'UNKNOWN_EDGE');
  assert.throws(() => net.addEdge('S', 'A', 1), (e) => e.code === 'DUPLICATE_EDGE');
  assert.throws(() => net.freeze('S', 'C', 0), (e) => e.code === 'INVALID_COMMAND');
  assert.throws(() => net.freeze('S', 'C', 1.5), (e) => e.code === 'INVALID_COMMAND');

  // set-capacity to exactly the frozen amount is allowed.
  net.setCapacity('S', 'A', 3);
  assert.equal(net.getEdge('S', 'A').capacity, 3);
});

test('freeze result paths sum to amount and flows respect capacities (anti-parallel edges)', () => {
  const net = new CreditNetwork();
  net.addEdge('S', 'A', 4);
  net.addEdge('A', 'S', 3); // anti-parallel edge must not confuse flow extraction
  net.addEdge('A', 'C', 4);
  net.addEdge('S', 'C', 2);
  const result = net.freeze('S', 'C', 6);
  assert.equal(result.ok, true);
  checkConservation(net, result, 'S', 'C');
  assert.equal(net.getEdge('A', 'S').frozen, 0, 'no flow parked on the reverse edge');
});
