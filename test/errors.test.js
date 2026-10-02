import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';

const config = {
  lines: [{ id: 'L1', budgetPerShift: 480 }],
  stations: [
    { id: 'DIAG', lineId: 'L1', capacityPerShift: 240 },
    { id: 'REPAIR', lineId: 'L1', capacityPerShift: 240 },
  ],
};

test('negative minutes are rejected as an error', () => {
  const scheduler = new Scheduler(config);
  const accepted = scheduler.addOrder({
    id: 'BAD1',
    route: [{ station: 'DIAG', minutes: -30 }],
  });
  assert.equal(accepted, false);
  const result = scheduler.run();
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'NEGATIVE_MINUTES');
  assert.equal(result.errors[0].orderId, 'BAD1');
  assert.equal(result.routes.length, 0);
  assert.equal(result.events.length, 0);
});

test('zero minutes are rejected as an error', () => {
  const scheduler = new Scheduler(config);
  assert.equal(
    scheduler.addOrder({ id: 'BAD0', route: [{ station: 'DIAG', minutes: 0 }] }),
    false,
  );
  assert.equal(scheduler.getResult().errors[0].code, 'NEGATIVE_MINUTES');
});

test('unknown station is rejected as an error', () => {
  const scheduler = new Scheduler(config);
  const accepted = scheduler.addOrder({
    id: 'BAD2',
    route: [{ station: 'NO_SUCH_STATION', minutes: 30 }],
  });
  assert.equal(accepted, false);
  const result = scheduler.run();
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'UNKNOWN_STATION');
  assert.equal(result.routes.length, 0);
});

test('a step exceeding the line shift budget is rejected as an error', () => {
  const scheduler = new Scheduler(config);
  const accepted = scheduler.addOrder({
    id: 'BAD3',
    route: [{ station: 'DIAG', minutes: 481 }],
  });
  assert.equal(accepted, false);
  const result = scheduler.run();
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'OVER_BUDGET');
  assert.equal(result.routes.length, 0);
});

test('invalid orders do not disturb valid ones', () => {
  const scheduler = new Scheduler(config);
  scheduler.addOrder({ id: 'OK', route: [{ station: 'DIAG', minutes: 100 }] });
  scheduler.addOrder({ id: 'BAD', route: [{ station: 'GHOST', minutes: 10 }] });
  const result = scheduler.run();
  assert.deepEqual(
    result.routes.map((r) => r.orderId),
    ['OK'],
  );
  assert.equal(result.errors.length, 1);
  assert.equal(scheduler.remainingCapacity.get('DIAG'), 140);
});
