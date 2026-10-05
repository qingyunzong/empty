import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/scheduler.js';

test('order waiting past the starvation threshold preempts the borrower', () => {
  const report = simulate({
    config: { starveAfter: 2, trace: true },
    tenants: [
      { id: 'R', parent: null, guarantee: 1 },
      { id: 'A', parent: 'R', guarantee: 1 },
      { id: 'B', parent: 'R', guarantee: 0 },
    ],
    orders: [
      { id: 'bg', tenant: 'B', duration: 10 },
      { id: 'urgent', tenant: 'A', duration: 1, arrive: 1 },
    ],
    horizon: 6,
  });

  // tick 0: B borrows A's idle guarantee
  assert.equal(report.borrowChain[0].lender, 'A');
  assert.equal(report.borrowChain[0].orderId, 'bg');

  // ticks 1-2: "urgent" waits (quota lent out, not yet starved)
  assert.deepEqual(report.schedule[1].preempted, []);
  assert.deepEqual(report.schedule[2].preempted, []);

  // tick 3: waited 3-1=2 >= starveAfter -> starvation reclaim kicks in
  assert.equal(report.preemptions.length, 1);
  const p = report.preemptions[0];
  assert.equal(p.tick, 3);
  assert.equal(p.reason, 'starvation');
  assert.equal(p.orderId, 'bg');
  assert.equal(p.lender, 'A');

  // starved order runs immediately on the reclaimed slot and completes
  const urgent = report.orders.find((o) => o.id === 'urgent');
  assert.equal(urgent.status, 'completed');
  assert.equal(urgent.startTick, 3);
  assert.equal(urgent.finishTick, 3);
  assert.equal(urgent.funding, 'A');

  // borrower was rolled back and later re-borrows the freed quota
  const bg = report.orders.find((o) => o.id === 'bg');
  assert.equal(bg.preempts, 1);
  assert.equal(report.schedule[4].started.includes('bg'), true);
});
