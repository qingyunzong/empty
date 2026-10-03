import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/tree.js';
import { Scheduler } from '../src/scheduler.js';
import { runScenario } from '../src/engine.js';

const multiLevelTenants = () => [
  { id: 'root', parent: null, capacity: 100 },
  { id: 'p', parent: 'root', guarantee: 35 },
  { id: 'b', parent: 'p', guarantee: 20 },
  { id: 'len', parent: 'root', guarantee: 30 },
];

const multiLevelOrders = () => [
  { id: 'b1', tenant: 'b', units: 20, priority: 1, submit: 0 },
  { id: 'b2', tenant: 'b', units: 15, priority: 1, submit: 0 },
  { id: 'p_wait', tenant: 'p', units: 15, priority: 1, submit: 1 },
  { id: 'l1', tenant: 'len', units: 25, priority: 1, submit: 2 },
];

function usedOf(tree, id) {
  return tree.nodes.get(id).used;
}

test('reclaim triggers multi-level rollback with exact released amount', () => {
  const tree = buildTree(multiLevelTenants());
  const scheduler = new Scheduler({ tree, orders: multiLevelOrders(), starveThreshold: 1 });

  scheduler.schedulePass(0);
  assert.equal(usedOf(tree, 'b'), 35);
  assert.equal(usedOf(tree, 'p'), 35);
  assert.equal(usedOf(tree, 'root'), 35);
  assert.equal(tree.nodes.get('len').lentOut, 15);
  assert.equal(tree.nodes.get('b').borrowedIn, 15);

  const { record, preemptions } = scheduler.reclaim('len', 2);

  assert.equal(record.need, 10);
  assert.equal(record.released, 10);
  assert.deepEqual(preemptions, [
    { time: 2, lender: 'len', borrower: 'b', order: 'b2', amount: 10 },
  ]);

  // multi-level rollback: b, p and root each drop by exactly the released 10
  assert.equal(usedOf(tree, 'b'), 25);
  assert.equal(usedOf(tree, 'p'), 25);
  assert.equal(tree.nodes.get('len').lentOut, 5);
  assert.equal(tree.nodes.get('b').borrowedIn, 5);
  assert.equal(scheduler.orderById.get('b2').active, 5);
  // reclaim re-schedules the lender's own waiting orders immediately
  assert.equal(scheduler.orderById.get('l1').active, 25);
  assert.equal(usedOf(tree, 'len'), 25);
  assert.equal(usedOf(tree, 'root'), 50);

  for (const [id] of tree.nodes) {
    assert.ok(
      tree.nodes.get(id).used <= scheduler.effLimit(id),
      `node ${id} must not exceed its limit after rollback`,
    );
  }

  scheduler.schedulePass(2);
  assert.equal(scheduler.orderById.get('l1').active, 25);
  assert.equal(scheduler.orderById.get('b2').active, 5);
  assert.equal(scheduler.orderById.get('p_wait').active, 0);
  assert.equal(usedOf(tree, 'len'), 25);
  assert.equal(usedOf(tree, 'root'), 50);
  assert.equal(scheduler.borrowEvents.length, 1);
  for (const [id] of tree.nodes) {
    assert.ok(tree.nodes.get(id).used <= scheduler.effLimit(id), `node ${id} within limit at end`);
  }
});

test('reclaim report via engine exposes preemptions and final schedule', () => {
  const report = runScenario({
    starveThreshold: 1,
    tenants: multiLevelTenants(),
    orders: multiLevelOrders(),
    commands: [
      { cmd: 'tick', time: 0 },
      { cmd: 'reclaim', tenant: 'len', time: 2 },
    ],
  });
  assert.equal(report.preemptions.length, 1);
  assert.equal(report.preemptions[0].amount, 10);
  assert.equal(report.reclaims[0].released, 10);
  const b2 = report.schedule.find((o) => o.id === 'b2');
  const l1 = report.schedule.find((o) => o.id === 'l1');
  assert.equal(b2.status, 'partial');
  assert.equal(b2.active, 5);
  assert.equal(l1.status, 'scheduled');
  for (const node of report.nodes) {
    assert.ok(node.used <= node.limit, `node ${node.id} within limit`);
  }
});

test('preemption picks the latest borrower first', () => {
  const tree = buildTree([
    { id: 'root', parent: null, capacity: 100 },
    { id: 'len', parent: 'root', guarantee: 30 },
    { id: 'x', parent: 'root', guarantee: 10 },
    { id: 'y', parent: 'root', guarantee: 10 },
  ]);
  const scheduler = new Scheduler({
    tree,
    orders: [
      { id: 'x1', tenant: 'x', units: 15, priority: 5, submit: 0 },
      { id: 'y1', tenant: 'y', units: 15, priority: 1, submit: 1 },
      { id: 'l1', tenant: 'len', units: 25, priority: 1, submit: 2 },
    ],
    starveThreshold: 99,
  });
  scheduler.schedulePass(0);
  scheduler.schedulePass(1);
  assert.equal(tree.nodes.get('len').lentOut, 10);

  const { record, preemptions } = scheduler.reclaim('len', 2);
  assert.equal(record.released, 5);
  assert.equal(preemptions.length, 1);
  assert.equal(preemptions[0].order, 'y1');
  assert.equal(preemptions[0].amount, 5);
  assert.equal(scheduler.orderById.get('y1').active, 10);
  assert.equal(scheduler.orderById.get('x1').active, 15);
});

test('preemption picks the lowest priority first among same-time borrows', () => {
  const tree = buildTree([
    { id: 'root', parent: null, capacity: 100 },
    { id: 'len', parent: 'root', guarantee: 30 },
    { id: 'x', parent: 'root', guarantee: 10 },
    { id: 'y', parent: 'root', guarantee: 10 },
  ]);
  const scheduler = new Scheduler({
    tree,
    orders: [
      { id: 'x1', tenant: 'x', units: 15, priority: 5, submit: 0 },
      { id: 'y1', tenant: 'y', units: 15, priority: 1, submit: 0 },
      { id: 'l1', tenant: 'len', units: 25, priority: 1, submit: 1 },
    ],
    starveThreshold: 99,
  });
  scheduler.schedulePass(0);
  assert.equal(tree.nodes.get('len').lentOut, 10);

  const { preemptions } = scheduler.reclaim('len', 1);
  assert.equal(preemptions.length, 1);
  assert.equal(preemptions[0].order, 'y1');
  assert.equal(preemptions[0].amount, 5);
  assert.equal(scheduler.orderById.get('y1').active, 10);
  assert.equal(scheduler.orderById.get('x1').active, 15);
});

test('reclaim without lender demand is a no-op', () => {
  const tree = buildTree([
    { id: 'root', parent: null, capacity: 100 },
    { id: 'len', parent: 'root', guarantee: 30 },
    { id: 'x', parent: 'root', guarantee: 10 },
  ]);
  const scheduler = new Scheduler({
    tree,
    orders: [{ id: 'x1', tenant: 'x', units: 15, priority: 1, submit: 0 }],
    starveThreshold: 3,
  });
  scheduler.schedulePass(0);
  assert.equal(tree.nodes.get('len').lentOut, 5);
  const { record, preemptions } = scheduler.reclaim('len', 1);
  assert.equal(record.need, 0);
  assert.equal(record.released, 0);
  assert.equal(preemptions.length, 0);
  assert.equal(scheduler.orderById.get('x1').active, 15);
});
