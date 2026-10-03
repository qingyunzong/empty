import test from 'node:test';
import assert from 'node:assert/strict';
import { Planner } from '../src/planner.js';
import { Calendar } from '../src/calendar.js';
import { normalizeOrder } from '../src/normalize.js';
import { enumerateSchedules } from '../src/reference.js';
import { CODES } from '../src/errors.js';

const CALENDAR_SPEC = {
  start: '2026-10-05T08:00:00Z',
  shifts: [{ days: [1], start: '08:00', end: '11:00' }],
};

const ORDER_A = {
  id: 'A',
  due: '2026-10-05T09:00:00Z',
  deadline: '2026-10-05T10:00:00Z',
  operations: [{ id: 'a1', machine: 'M1', cycleTime: 60 }],
};
const ORDER_B = {
  id: 'B',
  due: '2026-10-05T10:00:00Z',
  deadline: '2026-10-05T11:00:00Z',
  operations: [{ id: 'b1', machine: 'M1', cycleTime: 60 }],
};
const RUSH_R = {
  id: 'R',
  release: '2026-10-05T08:00:00Z',
  due: '2026-10-05T08:30:00Z',
  deadline: '2026-10-05T09:00:00Z',
  operations: [{ id: 'r1', machine: 'M1', cycleTime: 60 }],
};

function basePlanner() {
  return new Planner({ calendar: CALENDAR_SPEC, machines: ['M1'] });
}

function opStarts(plan, orderId) {
  return plan.orders.find((o) => o.orderId === orderId)?.ops.map((o) => [o.machine, o.start, o.end]);
}

test('acceptance 3: rush reschedule over budget rolls back with a provable gap', () => {
  const p = basePlanner();
  p.addOrder(ORDER_A);
  p.addOrder(ORDER_B);
  assert.equal(p.schedule().ok, true);
  const before = p.planJson();
  assert.deepEqual(opStarts(before, 'A'), [['M1', '2026-10-05T08:00:00.000Z', '2026-10-05T09:00:00.000Z']]);
  assert.deepEqual(opStarts(before, 'B'), [['M1', '2026-10-05T09:00:00.000Z', '2026-10-05T10:00:00.000Z']]);

  const r = p.insertRush(RUSH_R, { budget: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.BUDGET_EXCEEDED);
  assert.deepEqual(r.gap, { budget: 1, required: 2, deficit: 1, proven: true });

  assert.deepEqual(p.planJson(), before, 'state must be unchanged after budget failure');
  assert.equal(p.orders.has('R'), false, 'rush order must not be committed');

  const ref = enumerateSchedules({
    orders: [ORDER_A, ORDER_B, RUSH_R].map((o) => normalizeOrder(o, ['M1'])),
    calendar: new Calendar(CALENDAR_SPEC),
    machineIds: ['M1'],
    baseline: p.plan.placements,
    collect: true,
  });
  assert.equal(ref.proven, true);
  assert.ok(ref.collected.length >= 1, 'reference must find feasible schedules');
  for (const sched of ref.collected) {
    const rPlacement = sched.placements.get('R')[0];
    assert.equal(rPlacement.start, Date.parse('2026-10-05T08:00:00Z'));
    assert.ok(sched.disturbed >= 2, 'every feasible schedule disturbs both existing orders');
  }
  assert.equal(ref.best.disturbed, 2);
});

test('acceptance 3b: sufficient budget commits the rush reschedule', () => {
  const p = basePlanner();
  p.addOrder(ORDER_A);
  p.addOrder(ORDER_B);
  assert.equal(p.schedule().ok, true);
  const r = p.insertRush(RUSH_R, { budget: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.disturbedCount, 2);
  assert.deepEqual([...r.disturbed].sort(), ['A', 'B']);
  const plan = p.planJson();
  assert.deepEqual(opStarts(plan, 'R'), [['M1', '2026-10-05T08:00:00.000Z', '2026-10-05T09:00:00.000Z']]);
  assert.deepEqual(opStarts(plan, 'A'), [['M1', '2026-10-05T09:00:00.000Z', '2026-10-05T10:00:00.000Z']]);
  assert.deepEqual(opStarts(plan, 'B'), [['M1', '2026-10-05T10:00:00.000Z', '2026-10-05T11:00:00.000Z']]);
});

test('rush insertion with zero disturbance fits within budget 0', () => {
  const p = new Planner({
    calendar: {
      start: '2026-10-05T08:00:00Z',
      shifts: [{ days: [1], start: '08:00', end: '12:00' }],
    },
    machines: ['M1'],
  });
  p.addOrder({
    id: 'A',
    due: '2026-10-05T09:00:00Z',
    operations: [{ id: 'a1', machine: 'M1', cycleTime: 60 }],
  });
  assert.equal(p.schedule().ok, true);
  const r = p.insertRush(
    {
      id: 'R',
      due: '2026-10-05T11:00:00Z',
      operations: [{ id: 'r1', machine: 'M1', cycleTime: 60 }],
    },
    { budget: 0 },
  );
  assert.equal(r.ok, true);
  assert.equal(r.disturbedCount, 0);
});

test('infeasible rush reports INFEASIBLE and keeps state', () => {
  const p = basePlanner();
  p.addOrder(ORDER_A);
  assert.equal(p.schedule().ok, true);
  const before = p.planJson();
  const r = p.insertRush(
    {
      id: 'R',
      release: '2026-10-05T08:00:00Z',
      deadline: '2026-10-05T08:30:00Z',
      operations: [{ id: 'r1', machine: 'M1', cycleTime: 60 }],
    },
    { budget: 10 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.INFEASIBLE);
  assert.deepEqual(p.planJson(), before);
  assert.equal(p.orders.has('R'), false);
});
