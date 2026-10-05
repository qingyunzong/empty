import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/scheduler.js';

test('idle guarantee is lent and borrowed successfully', () => {
  const report = simulate({
    tenants: [
      { id: 'root', parent: null, guarantee: 2 },
      { id: 'A', parent: 'root', guarantee: 2 },
      { id: 'B', parent: 'root', guarantee: 0 },
    ],
    orders: [
      { id: 'b1', tenant: 'B', duration: 2, priority: 1 },
      { id: 'b2', tenant: 'B', duration: 2, priority: 0 },
    ],
  });
  assert.equal(report.ok, true);
  assert.equal(report.borrowChain.length, 2);
  for (const rec of report.borrowChain) {
    assert.equal(rec.lender, 'A');
    assert.equal(rec.borrower, 'B');
    assert.equal(rec.tick, 0);
    assert.equal(rec.status, 'completed');
  }
  const orders = Object.fromEntries(report.orders.map((o) => [o.id, o]));
  assert.equal(orders.b1.status, 'completed');
  assert.equal(orders.b2.status, 'completed');
  assert.equal(orders.b1.finishTick, 1);
  assert.equal(orders.b1.funding, 'A');
  assert.equal(report.summary.borrowedSlots, 2);
  // all quota returned after completion
  const nodeA = report.nodes.find((n) => n.id === 'A');
  assert.equal(nodeA.lentOut, 0);
  assert.equal(nodeA.ownLent, 0);
  assert.equal(report.nodes.find((n) => n.id === 'root').usage, 0);
});

test('own guarantee is used before borrowing', () => {
  const report = simulate({
    tenants: [
      { id: 'root', parent: null, guarantee: 3 },
      { id: 'A', parent: 'root', guarantee: 2 },
      { id: 'B', parent: 'root', guarantee: 1 },
    ],
    orders: [
      { id: 'x1', tenant: 'B', duration: 1 },
      { id: 'x2', tenant: 'B', duration: 1 },
    ],
  });
  const orders = Object.fromEntries(report.orders.map((o) => [o.id, o]));
  assert.equal(orders.x1.funding, 'B'); // own guarantee
  assert.equal(orders.x2.funding, 'A'); // borrowed idle quota
  assert.equal(report.borrowChain.length, 1);
});

test('total capacity never exceeds root cap', () => {
  const report = simulate({
    config: { trace: true },
    tenants: [
      { id: 'root', parent: null, guarantee: 2 },
      { id: 'A', parent: 'root', guarantee: 2 },
      { id: 'B', parent: 'root', guarantee: 0 },
    ],
    orders: [
      { id: 'a1', tenant: 'A', duration: 3 },
      { id: 'b1', tenant: 'B', duration: 3 },
      { id: 'b2', tenant: 'B', duration: 3 },
    ],
  });
  for (const ev of report.schedule) {
    assert.ok(ev.nodes.root.usage <= 2, `tick ${ev.tick}: root over cap`);
    assert.ok(ev.nodes.A.usage <= 2, `tick ${ev.tick}: A over cap`);
  }
  // A uses 1 own slot, B can only borrow the remaining 1 slot of A per tick
  const b1 = report.orders.find((o) => o.id === 'b1');
  const b2 = report.orders.find((o) => o.id === 'b2');
  assert.equal(b1.status, 'completed');
  assert.equal(b2.status, 'completed');
  assert.ok(b2.finishTick > b1.finishTick, 'second borrower waits for capacity');
});
