import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';
import { verifyEvents } from '../src/verify.js';

test('station calendars gate capacity per shift and budgets reset', () => {
  const config = {
    lines: [{ id: 'L1', budgetPerShift: 100 }],
    stations: [
      {
        id: 'DIAG',
        lineId: 'L1',
        capacityPerShift: 0,
        calendar: [{ capacity: 50 }, { capacity: 100 }, { capacity: 0 }],
      },
    ],
  };
  const order = { id: 'W1', route: [{ station: 'DIAG', minutes: 80 }] };
  const scheduler = new Scheduler(config);

  scheduler.addOrder(structuredClone(order));
  const first = scheduler.run(); // shift 0: capacity 50 < 80
  assert.equal(first.routes.length, 0);
  assert.equal(first.waiting.length, 1);

  const second = scheduler.advanceShift(); // shift 1: capacity 100 >= 80
  assert.equal(second.routes.length, 1);
  assert.equal(second.routes[0].steps[0].shift, 1);
  assert.equal(scheduler.remainingCapacity.get('DIAG'), 20);
  assert.equal(scheduler.remainingBudget.get('L1'), 20);

  const allEvents = [...first.events, ...second.events.slice(first.events.length)];
  const verification = verifyEvents(config, scheduler.getResult().events, [order]);
  assert.deepEqual(verification.violations, []);
  assert.ok(allEvents.length > 0);
});
