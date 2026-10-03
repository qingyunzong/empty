import test from 'node:test';
import assert from 'node:assert/strict';
import { Planner } from '../src/planner.js';
import { compareOrders } from '../src/scheduler.js';
import { CODES } from '../src/errors.js';

const T = (s) => Date.parse(s);

function acceptanceOnePlanner() {
  return new Planner({
    calendar: {
      start: '2026-10-05T08:00:00Z',
      shifts: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '20:00' }],
    },
    machines: ['M1', 'M2', 'M3'],
  });
}

test('acceptance 1: two orders, three machines, alternative-machine tie broken by minimal idle change', () => {
  const p = acceptanceOnePlanner();
  p.addOrder({
    id: 'O1',
    due: '2026-10-06T00:00:00Z',
    quantity: 1,
    operations: [
      { id: 'a1', machine: 'M2', cycleTime: 30 },
      { id: 'a2', machine: 'M1', cycleTime: 60 },
      { id: 'a3', machine: 'M2', cycleTime: 30 },
    ],
  });
  p.addOrder({
    id: 'O2',
    due: '2026-10-07T00:00:00Z',
    quantity: 1,
    operations: [
      { id: 'b1', machine: 'M3', cycleTime: 30 },
      { id: 'b2', machine: 'M2', cycleTime: 60, alternatives: ['M3'] },
    ],
  });
  const r = p.schedule();
  assert.equal(r.ok, true);
  const plan = p.planJson();
  const o1 = plan.orders.find((o) => o.orderId === 'O1');
  const o2 = plan.orders.find((o) => o.orderId === 'O2');
  assert.deepEqual(
    o1.ops.map((o) => [o.machine, o.start, o.end]),
    [
      ['M2', '2026-10-05T08:00:00.000Z', '2026-10-05T08:30:00.000Z'],
      ['M1', '2026-10-05T08:30:00.000Z', '2026-10-05T09:30:00.000Z'],
      ['M2', '2026-10-05T09:30:00.000Z', '2026-10-05T10:00:00.000Z'],
    ],
  );
  const b2 = o2.ops.find((o) => o.opId === 'b2');
  assert.equal(b2.machine, 'M2');
  assert.equal(b2.start, '2026-10-05T08:30:00.000Z');
  assert.equal(b2.end, '2026-10-05T09:30:00.000Z');
  const decision = plan.decisions.find((d) => d.orderId === 'O2' && d.opId === 'b2');
  assert.ok(decision, 'tie must be enumerated and recorded');
  assert.equal(decision.candidates.length, 2);
  const candM2 = decision.candidates.find((c) => c.machine === 'M2');
  const candM3 = decision.candidates.find((c) => c.machine === 'M3');
  assert.equal(candM2.idleDeltaMinutes, -60);
  assert.equal(candM3.idleDeltaMinutes, 0);
  assert.equal(decision.chosen.machine, 'M2');
  assert.equal(plan.totalIdleMinutes, 0);
});

test('acceptance 1b: equal idle delta falls back to machine id order', () => {
  const p = acceptanceOnePlanner();
  p.addOrder({
    id: 'O1',
    due: '2026-10-06T00:00:00Z',
    operations: [{ id: 'x1', machine: 'M3', cycleTime: 30, alternatives: ['M1'] }],
  });
  const r = p.schedule();
  assert.equal(r.ok, true);
  const op = p.planJson().orders[0].ops[0];
  assert.equal(op.machine, 'M1');
});

test('priority: due date, then quantity, then id', () => {
  const orders = [
    { id: 'C', quantity: 1, due: T('2026-01-02T00:00:00Z') },
    { id: 'A', quantity: 5, due: T('2026-01-01T00:00:00Z') },
    { id: 'D', quantity: 2, due: T('2026-01-01T00:00:00Z') },
    { id: 'B', quantity: 2, due: T('2026-01-01T00:00:00Z') },
  ];
  assert.deepEqual([...orders].sort(compareOrders).map((o) => o.id), ['B', 'D', 'A', 'C']);
});

test('waiting between operations is not counted as processing time', () => {
  const p = new Planner({
    calendar: {
      start: '2026-10-05T08:00:00Z',
      shifts: [{ days: [1], start: '08:00', end: '20:00' }],
    },
    machines: ['M1', 'M2'],
  });
  p.addOrder({
    id: 'Y',
    due: '2026-10-05T12:00:00Z',
    operations: [{ id: 'y1', machine: 'M2', cycleTime: 60 }],
  });
  p.addOrder({
    id: 'X',
    due: '2026-10-05T18:00:00Z',
    operations: [
      { id: 'x1', machine: 'M1', cycleTime: 30 },
      { id: 'x2', machine: 'M2', cycleTime: 30 },
    ],
  });
  assert.equal(p.schedule().ok, true);
  const x = p.planJson().orders.find((o) => o.orderId === 'X');
  const x2 = x.ops.find((o) => o.opId === 'x2');
  assert.equal(x2.start, '2026-10-05T09:00:00.000Z');
  assert.equal(x2.durationMinutes, 30);
  const waited = T(x2.start) - T(x.ops[0].end);
  assert.equal(waited, 30 * 60 * 1000);
});

test('quantity scales operation duration via cycle time', () => {
  const p = new Planner({
    calendar: {
      start: '2026-10-05T08:00:00Z',
      shifts: [{ days: [1], start: '08:00', end: '20:00' }],
    },
    machines: ['M1'],
  });
  p.addOrder({ id: 'Q', quantity: 2, operations: [{ id: 'q1', machine: 'M1', cycleTime: 30 }] });
  assert.equal(p.schedule().ok, true);
  assert.equal(p.planJson().orders[0].ops[0].durationMinutes, 60);
});

test('cyclic route raises CYCLIC_ROUTE', () => {
  const p = acceptanceOnePlanner();
  assert.throws(
    () =>
      p.addOrder({
        id: 'O',
        operations: [
          { id: 'a', machine: 'M1', cycleTime: 10 },
          { id: 'b', machine: 'M1', cycleTime: 10 },
        ],
        route: ['a', 'b', 'a'],
      }),
    (e) => e.code === CODES.CYCLIC_ROUTE,
  );
});

test('unknown machine raises VALIDATION', () => {
  const p = acceptanceOnePlanner();
  assert.throws(
    () => p.addOrder({ id: 'O', operations: [{ id: 'a', machine: 'M9', cycleTime: 10 }] }),
    (e) => e.code === CODES.VALIDATION,
  );
});

test('impossible deadline reports INFEASIBLE and keeps previous plan', () => {
  const p = new Planner({
    calendar: {
      start: '2026-10-05T08:00:00Z',
      shifts: [{ days: [1], start: '08:00', end: '20:00' }],
    },
    machines: ['M1'],
  });
  p.addOrder({
    id: 'O',
    release: '2026-10-05T08:00:00Z',
    deadline: '2026-10-05T08:30:00Z',
    operations: [{ id: 'a', machine: 'M1', cycleTime: 60 }],
  });
  const r = p.schedule();
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.INFEASIBLE);
  assert.equal(p.planJson().orders.length, 0);
});
