import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../src/engine.js';

function scenario(starveThreshold) {
  return {
    starveThreshold,
    tenants: [
      { id: 'root', parent: null, capacity: 100 },
      { id: 'len', parent: 'root', guarantee: 20 },
      { id: 'b', parent: 'root', guarantee: 0 },
    ],
    orders: [
      { id: 'l0', tenant: 'len', units: 4, priority: 1, submit: 0 },
      { id: 'b1', tenant: 'b', units: 10, priority: 1, submit: 0 },
      { id: 'l_big', tenant: 'len', units: 18, priority: 1, submit: 1 },
      { id: 'b2', tenant: 'b', units: 6, priority: 1, submit: 4 },
    ],
    commands: [
      { cmd: 'tick', time: 0 },
      { cmd: 'tick', time: 5 },
    ],
  };
}

test('starved tenant quota is reserved and not lent out', () => {
  const report = runScenario(scenario(3));
  const b1 = report.schedule.find((o) => o.id === 'b1');
  const b2 = report.schedule.find((o) => o.id === 'b2');
  const lBig = report.schedule.find((o) => o.id === 'l_big');

  assert.equal(b1.active, 10);
  assert.equal(b2.active, 0);
  assert.equal(b2.status, 'waiting');
  assert.equal(lBig.status, 'waiting');

  const borrowsAt5 = report.borrowChain.filter((e) => e.time === 5);
  assert.equal(borrowsAt5.length, 0);
  assert.equal(report.borrowChain.length, 1);
  assert.equal(report.borrowChain[0].amount, 10);
});

test('without starvation pressure the same borrow succeeds', () => {
  const report = runScenario(scenario(99));
  const b2 = report.schedule.find((o) => o.id === 'b2');
  assert.equal(b2.active, 6);
  assert.equal(b2.status, 'scheduled');
  const borrowsAt5 = report.borrowChain.filter((e) => e.time === 5);
  assert.deepEqual(borrowsAt5, [
    { time: 5, lender: 'len', borrower: 'b', order: 'b2', amount: 6 },
  ]);
});
