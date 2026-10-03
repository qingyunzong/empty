import test from 'node:test';
import assert from 'node:assert/strict';
import { runJob } from '../cli.js';

const CALENDAR = {
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

test('CLI one-shot scheduling produces plan JSON', () => {
  const json = runJob({ calendar: CALENDAR, machines: ['M1'], orders: [ORDER_A, ORDER_B] });
  assert.equal(json.ok, true);
  assert.equal(json.plan.orders.length, 2);
  assert.equal(json.plan.orders[0].ops[0].start, '2026-10-05T08:00:00.000Z');
});

test('CLI command script: rush over budget fails with BUDGET_EXCEEDED and gap', () => {
  const json = runJob({
    calendar: CALENDAR,
    machines: ['M1'],
    commands: [
      { op: 'addOrders', orders: [ORDER_A, ORDER_B] },
      { op: 'schedule' },
      { op: 'insertRush', order: RUSH_R, budget: 1 },
    ],
  });
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'BUDGET_EXCEEDED');
  assert.deepEqual(json.error.gap, { budget: 1, required: 2, deficit: 1, proven: true });
  assert.equal(json.results.length, 3);
});

test('CLI command script: rush with sufficient budget plus undo/redo', () => {
  const json = runJob({
    calendar: CALENDAR,
    machines: ['M1'],
    commands: [
      { op: 'addOrders', orders: [ORDER_A, ORDER_B] },
      { op: 'schedule' },
      { op: 'insertRush', order: RUSH_R, budget: 2 },
      { op: 'undo' },
      { op: 'redo' },
    ],
  });
  assert.equal(json.ok, true);
  assert.equal(json.plan.orders.length, 3);
  const r = json.plan.orders.find((o) => o.orderId === 'R');
  assert.equal(r.ops[0].start, '2026-10-05T08:00:00.000Z');
});

test('CLI cyclic route reports CYCLIC_ROUTE', () => {
  assert.throws(
    () =>
      runJob({
        calendar: CALENDAR,
        machines: ['M1'],
        orders: [
          {
            id: 'O',
            operations: [
              { id: 'a', machine: 'M1', cycleTime: 10 },
              { id: 'b', machine: 'M1', cycleTime: 10 },
            ],
            route: ['a', 'b', 'a'],
          },
        ],
      }),
    (e) => e.code === 'CYCLIC_ROUTE',
  );
});

test('CLI calendar overlap reports CALENDAR_OVERLAP', () => {
  assert.throws(
    () =>
      runJob({
        calendar: {
          ...CALENDAR,
          downtime: [
            { start: '2026-10-05T09:00:00Z', end: '2026-10-05T10:00:00Z' },
            { start: '2026-10-05T09:30:00Z', end: '2026-10-05T10:30:00Z' },
          ],
        },
        machines: ['M1'],
        orders: [ORDER_A],
      }),
    (e) => e.code === 'CALENDAR_OVERLAP',
  );
});
