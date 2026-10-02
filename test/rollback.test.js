import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';
import { verifyEvents } from '../src/verify.js';

function makeConfig(overrides = {}) {
  return {
    lines: [{ id: 'L1', budgetPerShift: overrides.budget ?? 1000 }],
    stations: [
      { id: 'DIAG', lineId: 'L1', capacityPerShift: overrides.diag ?? 500 },
      { id: 'REPAIR', lineId: 'L1', capacityPerShift: overrides.repair ?? 500 },
      { id: 'RECHECK', lineId: 'L1', capacityPerShift: overrides.recheck ?? 500 },
    ],
  };
}

const order = {
  id: 'W1',
  route: [
    { station: 'DIAG', minutes: 100 },
    { station: 'REPAIR', minutes: 200 },
    { station: 'RECHECK', minutes: 150 },
  ],
};

test('failure at level 2 rolls back level 1 precisely', () => {
  const config = makeConfig({ repair: 150 }); // REPAIR cannot fit 200min
  const scheduler = new Scheduler(config);
  scheduler.addOrder(structuredClone(order));
  const result = scheduler.run();

  assert.equal(result.routes.length, 0);
  assert.equal(result.budgetDeductions.length, 0);
  assert.ok(result.rollbacks.length >= 1);
  for (const rollback of result.rollbacks) {
    assert.deepEqual(
      rollback.released.map((r) => [r.level, r.station, r.minutes]),
      [[0, 'DIAG', 100]],
    );
  }
  assert.equal(result.rollbacks[0].orderId, 'W1');
  assert.match(result.rollbacks[0].reason, /REPAIR/);

  // every tentative hold released: resources back to their initial values
  assert.equal(scheduler.remainingCapacity.get('DIAG'), 500);
  assert.equal(scheduler.remainingCapacity.get('REPAIR'), 150);
  assert.equal(scheduler.remainingCapacity.get('RECHECK'), 500);
  assert.equal(scheduler.remainingBudget.get('L1'), 1000);
  assert.equal(scheduler.allocations.size, 0);
  assert.deepEqual(result.waiting.map((w) => w.orderId), ['W1']);

  const verification = verifyEvents(config, result.events, [order]);
  assert.deepEqual(verification.violations, []);
});

test('failure at level 3 rolls back levels 1 and 2 precisely', () => {
  const config = makeConfig({ recheck: 100 }); // RECHECK cannot fit 150min
  const scheduler = new Scheduler(config);
  scheduler.addOrder(structuredClone(order));
  const result = scheduler.run();

  assert.equal(result.routes.length, 0);
  assert.ok(result.rollbacks.length >= 1);
  for (const rollback of result.rollbacks) {
    assert.deepEqual(
      rollback.released.map((r) => [r.level, r.station, r.minutes]),
      [
        [0, 'DIAG', 100],
        [1, 'REPAIR', 200],
      ],
    );
  }

  assert.equal(scheduler.remainingCapacity.get('DIAG'), 500);
  assert.equal(scheduler.remainingCapacity.get('REPAIR'), 500);
  assert.equal(scheduler.remainingCapacity.get('RECHECK'), 100);
  assert.equal(scheduler.remainingBudget.get('L1'), 1000);
  assert.equal(scheduler.allocations.size, 0);

  const verification = verifyEvents(config, result.events, [order]);
  assert.deepEqual(verification.violations, []);
});

test('budget exhaustion at a later level also rolls back earlier holds', () => {
  const config = makeConfig({ budget: 250 }); // 100+200 exceeds the budget at level 2
  const scheduler = new Scheduler(config);
  scheduler.addOrder(structuredClone(order));
  const result = scheduler.run();

  assert.equal(result.routes.length, 0);
  assert.ok(result.rollbacks.length >= 1);
  assert.match(result.rollbacks[0].reason, /budget/);
  assert.equal(scheduler.remainingCapacity.get('DIAG'), 500);
  assert.equal(scheduler.remainingBudget.get('L1'), 250);

  const verification = verifyEvents(config, result.events, [order]);
  assert.deepEqual(verification.violations, []);
});
