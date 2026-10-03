import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/tree.js';
import { Scheduler } from '../src/scheduler.js';
import { runScenario } from '../src/engine.js';

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function assertInvariants(scheduler) {
  for (const [id] of scheduler.nodes) {
    const node = scheduler.nodes.get(id);
    assert.ok(node.used >= 0, `node ${id} used >= 0`);
    assert.ok(node.lentOut >= 0, `node ${id} lentOut >= 0`);
    assert.ok(node.used <= scheduler.effLimit(id), `node ${id} within effective limit`);
    if (id !== scheduler.rootId) {
      assert.ok(node.lentOut <= node.guarantee, `node ${id} lends at most its guarantee`);
    }
  }
  for (const order of scheduler.orders) {
    assert.ok(order.active >= 0 && order.active <= order.units, `order ${order.id} active within [0, units]`);
  }
  for (const borrow of scheduler.borrows) {
    assert.ok(borrow.amount >= 0, 'borrow amount non-negative');
  }
}

test('greedy fallback keeps every node within its limit', () => {
  const rand = lcg(424242);
  const pick = (n) => Math.floor(rand() * n);
  const tenants = [{ id: 'root', parent: null, capacity: 0 }];
  let sum = 0;
  for (let t = 0; t < 6; t += 1) {
    const g = 2 + pick(10);
    sum += g;
    tenants.push({ id: `T${t}`, parent: 'root', guarantee: g });
  }
  tenants[0].capacity = sum;
  const orders = [];
  for (let o = 0; o < 15; o += 1) {
    orders.push({
      id: `o${o}`,
      tenant: `T${pick(6)}`,
      units: 1 + pick(8),
      priority: pick(3),
      submit: 0,
    });
  }
  const tree = buildTree(tenants);
  const scheduler = new Scheduler({ tree, orders, starveThreshold: 2 });
  scheduler.schedulePass(0);
  assertInvariants(scheduler);
  scheduler.schedulePass(5);
  assertInvariants(scheduler);
});

test('commands are processed in time order regardless of input order', () => {
  const report = runScenario({
    tenants: [
      { id: 'root', parent: null, capacity: 10 },
      { id: 'a', parent: 'root', guarantee: 10 },
    ],
    orders: [
      { id: 'early', tenant: 'a', units: 4, submit: 0 },
      { id: 'late', tenant: 'a', units: 4, submit: 5 },
    ],
    commands: [
      { cmd: 'tick', time: 6 },
      { cmd: 'tick', time: 0 },
    ],
  });
  assert.equal(report.time, 6);
  assert.equal(report.schedule.find((o) => o.id === 'early').status, 'scheduled');
  assert.equal(report.schedule.find((o) => o.id === 'late').status, 'scheduled');
  assert.equal(report.utilization.used, 8);
});

test('repeated borrow and reclaim cycles keep invariants', () => {
  const rand = lcg(777);
  const pick = (n) => Math.floor(rand() * n);
  const tenants = [
    { id: 'root', parent: null, capacity: 40 },
    { id: 'A', parent: 'root', guarantee: 15 },
    { id: 'B', parent: 'root', guarantee: 10 },
    { id: 'C', parent: 'root', guarantee: 12 },
  ];
  const orders = [];
  const names = ['A', 'B', 'C'];
  for (let o = 0; o < 9; o += 1) {
    orders.push({
      id: `o${o}`,
      tenant: names[pick(3)],
      units: 3 + pick(10),
      priority: pick(3),
      submit: pick(3),
    });
  }
  const tree = buildTree(tenants);
  const scheduler = new Scheduler({ tree, orders, starveThreshold: 2 });
  for (let t = 0; t < 6; t += 1) {
    scheduler.schedulePass(t);
    assertInvariants(scheduler);
    scheduler.reclaim(names[pick(3)], t);
    assertInvariants(scheduler);
    scheduler.schedulePass(t);
    assertInvariants(scheduler);
  }
});
