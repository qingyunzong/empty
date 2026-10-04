'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CreditNetwork } = require('../src/credit-network');

function buildMultiPath() {
  const net = new CreditNetwork();
  net.addEdge('S', 'A', 5);
  net.addEdge('S', 'B', 5);
  net.addEdge('A', 'B', 2);
  net.addEdge('A', 'T', 3);
  net.addEdge('B', 'T', 5);
  return net;
}

function occupiedOf(net) {
  const out = [];
  for (const [u, row] of net.occupied) {
    for (const [v, f] of row) out.push({ from: u, to: v, amount: f });
  }
  return out;
}

function assertFlowConservation(result, source, target) {
  const balance = new Map();
  for (const { from, to, amount } of result.flows) {
    balance.set(from, (balance.get(from) || 0) - amount);
    balance.set(to, (balance.get(to) || 0) + amount);
  }
  for (const [node, b] of balance) {
    if (node === source) assert.equal(b, -result.amount, 'source outflow');
    else if (node === target) assert.equal(b, result.amount, 'target inflow');
    else assert.equal(b, 0, `conservation at ${node}`);
  }
}

test('acceptance 1: multi-path freeze succeeds with per-edge flow decomposition', () => {
  const net = buildMultiPath();
  const result = net.freeze({ source: 'S', target: 'T', amount: 6 });
  assert.equal(result.ok, true);
  assert.equal(result.amount, 6);
  const total = result.flows.reduce((s, f) => s + f.amount, 0);
  assert.ok(total >= 6);
  assertFlowConservation(result, 'S', 'T');
  // Uses multiple paths: both S->A and S->B (or A->B detour) must carry flow.
  const outOfS = result.flows.filter((f) => f.from === 'S');
  assert.equal(outOfS.reduce((s, f) => s + f.amount, 0), 6);
  // Frozen capacity occupies edges immediately.
  for (const { from, to, amount } of result.flows) {
    assert.equal(net.occupied.get(from).get(to), amount);
  }
  assert.equal(net.maxFreezable('S', 'T'), 8 - 6);
});

test('acceptance 2: partial release frees capacity; re-freeze stays within capacity', () => {
  const net = buildMultiPath();
  const f1 = net.freeze({ source: 'S', target: 'T', amount: 6 });
  assert.equal(f1.ok, true);

  const rel = net.release({ id: f1.id, amount: 2 });
  assert.equal(rel.ok, true);
  assert.equal(rel.remaining, 4);
  assert.equal(net.maxFreezable('S', 'T'), 8 - 4);

  const f2 = net.freeze({ source: 'S', target: 'T', amount: 4 });
  assert.equal(f2.ok, true);

  // Total frozen per edge never exceeds capacity.
  for (const [u, row] of net.capacity) {
    for (const [v, cap] of row) {
      assert.ok(net.occupied.get(u).get(v) <= cap, `${u}->${v}`);
    }
  }
  assert.equal(net.maxFreezable('S', 'T'), 0);
  // One more unit must be rejected.
  const f3 = net.freeze({ source: 'S', target: 'T', amount: 1 });
  assert.equal(f3.ok, false);
  assert.equal(f3.cut.capacity, 0);
});

test('acceptance 3: insufficient credit rejects, state unchanged, cut equals max freezable', () => {
  const net = buildMultiPath();
  const before = JSON.stringify(occupiedOf(net));
  const freezeCount = net.freezes.size;

  const result = net.freeze({ source: 'S', target: 'T', amount: 9 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INSUFFICIENT_CAPACITY');
  assert.equal(result.maxFreezable, 8);
  assert.equal(result.cut.capacity, 8);
  // Cut edges cross from source side to customer side.
  const side = new Set(result.cut.sourceSide);
  assert.ok(side.has('S'));
  assert.ok(result.cut.customerSide.includes('T'));
  for (const e of result.cut.edges) {
    assert.ok(side.has(e.from), `${e.from} on source side`);
    assert.ok(!side.has(e.to), `${e.to} on customer side`);
  }
  assert.equal(result.cut.edges.reduce((s, e) => s + e.capacity, 0), 8);

  // State unchanged.
  assert.equal(JSON.stringify(occupiedOf(net)), before);
  assert.equal(net.freezes.size, freezeCount);

  // The certified bound is tight: freezing exactly 8 succeeds.
  assert.equal(net.freeze({ source: 'S', target: 'T', amount: 8 }).ok, true);
});

test('release errors: duplicate, over-release, unknown id', () => {
  const net = buildMultiPath();
  const f = net.freeze({ source: 'S', target: 'T', amount: 4 });
  net.release({ id: f.id, amount: 4 });
  assert.throws(() => net.release({ id: f.id, amount: 1 }), /fully released/);

  const g = net.freeze({ source: 'S', target: 'T', amount: 2 });
  assert.throws(() => net.release({ id: g.id, amount: 3 }), /only 2 remains/);
  assert.throws(() => net.release({ id: 'nope' }), /unknown freeze id/);
});

test('freeze errors: unknown source, unknown target, bad amount, duplicate id', () => {
  const net = buildMultiPath();
  assert.throws(() => net.freeze({ source: 'X', target: 'T', amount: 1 }), /unknown source/);
  assert.throws(() => net.freeze({ source: 'S', target: 'X', amount: 1 }), /unknown target/);
  assert.throws(() => net.freeze({ source: 'S', target: 'T', amount: 0 }), /positive integer/);
  const f = net.freeze({ source: 'S', target: 'T', amount: 1, id: 'k' });
  assert.equal(f.id, 'k');
  assert.throws(() => net.freeze({ source: 'S', target: 'T', amount: 1, id: 'k' }), /already in use/);
});

test('capacity management: set-capacity respects frozen amounts', () => {
  const net = buildMultiPath();
  net.freeze({ source: 'S', target: 'T', amount: 5 });
  const used = net.occupied.get('S').get('A') || 0;
  if (used > 0) {
    assert.throws(() => net.setCapacity('S', 'A', used - 1), /below frozen/);
    assert.equal(net.setCapacity('S', 'A', used).ok, true);
  }
  assert.throws(() => net.setCapacity('S', 'ZZ', 1), /does not exist/);
  assert.throws(() => net.addEdge('S', 'A', 1), /already exists/);
});
