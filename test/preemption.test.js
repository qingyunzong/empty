import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';
import { verifyEvents } from '../src/verify.js';

const config = {
  lines: [{ id: 'L1', budgetPerShift: 10_000 }],
  stations: [
    { id: 'A', lineId: 'L1', capacityPerShift: 100 },
    { id: 'B', lineId: 'L1', capacityPerShift: 100 },
    { id: 'C', lineId: 'L1', capacityPerShift: 100 },
  ],
};

const route = () => [
  { station: 'A', minutes: 60 },
  { station: 'B', minutes: 60 },
  { station: 'C', minutes: 60 },
];

test('high priority preempts a normal order across a complete contiguous segment', () => {
  const scheduler = new Scheduler(config);
  scheduler.addOrder({ id: 'N1', priority: 'normal', route: route() });
  scheduler.run();
  assert.deepEqual(
    scheduler.getResult().routes.map((r) => r.orderId),
    ['N1'],
  );

  scheduler.addOrder({ id: 'H1', priority: 'high', route: route() });
  const result = scheduler.run();

  // H1 takes over; N1 is evicted and waits
  assert.deepEqual(
    result.routes.map((r) => r.orderId),
    ['H1'],
  );
  assert.equal(result.preemptions.length, 1);
  const preemption = result.preemptions[0];
  assert.equal(preemption.by, 'H1');
  assert.equal(preemption.victim, 'N1');
  assert.deepEqual(preemption.segment, ['A', 'B', 'C']);
  assert.equal(preemption.released.length, 3);

  // victim's resources were fully returned before H1 consumed them
  assert.equal(scheduler.remainingBudget.get('L1'), 10_000 - 180);
  assert.equal(scheduler.remainingCapacity.get('A'), 40);

  // N1 is queued with a preemption counted and could not fit this shift
  assert.deepEqual(result.waiting.map((w) => w.orderId), ['N1']);
  assert.equal(result.waiting[0].preemptedCount, 1);

  const verification = verifyEvents(config, result.events, [
    { id: 'N1', route: route() },
    { id: 'H1', route: route() },
  ]);
  assert.deepEqual(verification.violations, []);

  // next shift frees capacity: the aging victim is re-dispatched
  const next = scheduler.advanceShift();
  const n1 = next.routes.find((r) => r.orderId === 'N1');
  assert.ok(n1, 'N1 must be re-routed after the shift rollover');
  assert.equal(n1.steps[0].shift, 1);
  assert.equal(next.waiting.length, 0);
});

test('preemption is refused when the shared stations are not a contiguous segment', () => {
  const scheduler = new Scheduler(config);
  // victim touches A at levels 0 and 2 with B in between
  scheduler.addOrder({
    id: 'N1',
    priority: 'normal',
    route: [
      { station: 'A', minutes: 40 },
      { station: 'B', minutes: 10 },
      { station: 'A', minutes: 40 },
    ],
  });
  scheduler.run();
  assert.equal(scheduler.remainingCapacity.get('A'), 20);

  scheduler.addOrder({ id: 'H1', priority: 'high', route: [{ station: 'A', minutes: 50 }] });
  const result = scheduler.run();

  // shared stations {A} sit at victim indices 0 and 2 -> not contiguous -> no preemption
  assert.equal(result.preemptions.length, 0);
  assert.deepEqual(
    result.routes.map((r) => r.orderId),
    ['N1'],
  );
  assert.deepEqual(result.waiting.map((w) => w.orderId), ['H1']);
});

test('aging reorders the waiting queue so older normal orders dispatch first', () => {
  const scheduler = new Scheduler({
    lines: [{ id: 'L1', budgetPerShift: 10_000 }],
    stations: [{ id: 'A', lineId: 'L1', capacityPerShift: 100 }],
  });
  scheduler.addOrder({ id: 'N1', route: [{ station: 'A', minutes: 60 }] });
  scheduler.run(); // N1 occupies the only capacity

  scheduler.addOrder({ id: 'N2', route: [{ station: 'A', minutes: 60 }] });
  scheduler.run(); // N2 waits, ages
  scheduler.addOrder({ id: 'N3', route: [{ station: 'A', minutes: 60 }] });
  scheduler.run(); // N3 waits; N2 has aged longer

  const before = scheduler.getResult();
  const ageOf = (id) => before.waiting.find((w) => w.orderId === id).age;
  assert.ok(ageOf('N2') > ageOf('N3'), 'N2 must be older than N3');

  const next = scheduler.advanceShift(); // capacity resets to 100, fits exactly one
  const n2 = next.routes.find((r) => r.orderId === 'N2');
  assert.ok(n2, 'the most-aged waiting order wins the freed capacity');
  assert.equal(n2.steps[0].shift, 1);
  assert.deepEqual(
    next.waiting.map((w) => w.orderId),
    ['N3'],
  );
});
