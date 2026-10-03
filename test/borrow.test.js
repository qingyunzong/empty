import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../src/engine.js';

test('borrowing idle quota from another tenant succeeds', () => {
  const report = runScenario({
    starveThreshold: 3,
    tenants: [
      { id: 'root', parent: null, capacity: 100 },
      { id: 'alpha', parent: 'root', guarantee: 30 },
      { id: 'beta', parent: 'root', guarantee: 10 },
    ],
    orders: [{ id: 'b1', tenant: 'beta', units: 25, priority: 1, submit: 0 }],
    commands: [{ cmd: 'tick', time: 0 }],
  });

  const order = report.schedule.find((o) => o.id === 'b1');
  assert.equal(order.active, 25);
  assert.equal(order.status, 'scheduled');

  assert.deepEqual(report.borrowChain, [
    { time: 0, lender: 'alpha', borrower: 'beta', order: 'b1', amount: 15 },
  ]);
  assert.deepEqual(report.borrows, [
    { lender: 'alpha', borrower: 'beta', order: 'b1', amount: 15, time: 0 },
  ]);

  const alpha = report.nodes.find((n) => n.id === 'alpha');
  const beta = report.nodes.find((n) => n.id === 'beta');
  const root = report.nodes.find((n) => n.id === 'root');
  assert.equal(alpha.lentOut, 15);
  assert.equal(alpha.used, 0);
  assert.equal(beta.borrowedIn, 15);
  assert.equal(beta.used, 25);
  assert.equal(beta.limit, 25);
  assert.equal(root.used, 25);
  assert.equal(report.utilization.used, 25);
  assert.equal(report.preemptions.length, 0);
});

test('borrow is impossible when the lender has no idle quota', () => {
  const report = runScenario({
    tenants: [
      { id: 'root', parent: null, capacity: 100 },
      { id: 'alpha', parent: 'root', guarantee: 30 },
      { id: 'beta', parent: 'root', guarantee: 10 },
    ],
    orders: [
      { id: 'a1', tenant: 'alpha', units: 30, priority: 1, submit: 0 },
      { id: 'b1', tenant: 'beta', units: 25, priority: 1, submit: 0 },
    ],
    commands: [{ cmd: 'tick', time: 0 }],
  });
  const b1 = report.schedule.find((o) => o.id === 'b1');
  assert.equal(b1.active, 0);
  assert.equal(b1.status, 'waiting');
  assert.equal(report.borrowChain.length, 0);
});

test('ancestor cap binds: borrowing cannot lift a parent limit', () => {
  const report = runScenario({
    tenants: [
      { id: 'root', parent: null, capacity: 100 },
      { id: 'p', parent: 'root', guarantee: 12 },
      { id: 'beta', parent: 'p', guarantee: 10 },
      { id: 'alpha', parent: 'root', guarantee: 30 },
    ],
    orders: [{ id: 'b1', tenant: 'beta', units: 20, priority: 1, submit: 0 }],
    commands: [{ cmd: 'tick', time: 0 }],
  });
  const b1 = report.schedule.find((o) => o.id === 'b1');
  assert.equal(b1.active, 0);
  assert.equal(report.borrowChain.length, 0);
});

test('orders are atomic: no partial scheduling without preemption', () => {
  const report = runScenario({
    tenants: [
      { id: 'root', parent: null, capacity: 100 },
      { id: 'alpha', parent: 'root', guarantee: 5 },
      { id: 'beta', parent: 'root', guarantee: 10 },
    ],
    orders: [{ id: 'b1', tenant: 'beta', units: 25, priority: 1, submit: 0 }],
    commands: [{ cmd: 'tick', time: 0 }],
  });
  const b1 = report.schedule.find((o) => o.id === 'b1');
  assert.equal(b1.active, 0);
  assert.equal(b1.status, 'waiting');
});
