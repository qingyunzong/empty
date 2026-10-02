import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';
import { verifyEvents } from '../src/verify.js';

const config = {
  lines: [{ id: 'L1', budgetPerShift: 1000 }],
  stations: [
    { id: 'DIAG', lineId: 'L1', capacityPerShift: 500 },
    { id: 'REPAIR', lineId: 'L1', capacityPerShift: 500 },
    { id: 'RECHECK', lineId: 'L1', capacityPerShift: 500 },
  ],
};

const order = {
  id: 'W1',
  route: [
    { station: 'DIAG', minutes: 100 },
    { station: 'REPAIR', minutes: 200 },
    { station: 'RECHECK', minutes: 150 },
  ],
};

test('atomic allocation: all three levels succeed together', () => {
  const scheduler = new Scheduler(config);
  assert.equal(scheduler.addOrder(structuredClone(order)), true);
  const result = scheduler.run();

  assert.equal(result.errors.length, 0);
  assert.equal(result.rollbacks.length, 0);
  assert.equal(result.preemptions.length, 0);
  assert.equal(result.waiting.length, 0);

  assert.equal(result.routes.length, 1);
  assert.deepEqual(
    result.routes[0].steps.map((s) => s.station),
    ['DIAG', 'REPAIR', 'RECHECK'],
  );

  assert.equal(result.budgetDeductions.length, 3);
  assert.deepEqual(
    result.budgetDeductions.map((d) => [d.level, d.station, d.minutes]),
    [
      [0, 'DIAG', 100],
      [1, 'REPAIR', 200],
      [2, 'RECHECK', 150],
    ],
  );
  assert.equal(result.budgetDeductions.reduce((sum, d) => sum + d.minutes, 0), 450);

  assert.equal(scheduler.remainingCapacity.get('DIAG'), 400);
  assert.equal(scheduler.remainingCapacity.get('REPAIR'), 300);
  assert.equal(scheduler.remainingCapacity.get('RECHECK'), 350);
  assert.equal(scheduler.remainingBudget.get('L1'), 550);

  const verification = verifyEvents(config, result.events, [order]);
  assert.deepEqual(verification.violations, []);
  assert.ok(verification.ok);
});
