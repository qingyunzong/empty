import test from 'node:test'
import assert from 'node:assert/strict'
import { Planner } from '../src/planner.js'
import { subtractIntervals } from '../src/calendar.js'

const baseCalendar = {
  start: '2026-01-05T00:00:00Z', // Monday
  days: 1,
  shifts: [{ days: [1], start: '08:00', end: '16:00' }],
}

function opOf(plan, orderId, seq) {
  return plan.orders.find((o) => o.id === orderId)?.operations.find((op) => op.seq === seq)
}

test('cyclic route is rejected with CYCLIC_ROUTE', () => {
  const cyclic = (steps) => ({
    calendar: baseCalendar,
    machines: [{ id: 'M1' }],
    orders: [{ id: 'O1', product: 'P', quantity: 1, route: { steps } }],
  })
  assert.throws(
    () => new Planner(cyclic([
      { id: 'a', next: 'b', machines: ['M1'], cycle: 10 },
      { id: 'b', next: 'a', machines: ['M1'], cycle: 10 },
    ])),
    (err) => err.code === 'CYCLIC_ROUTE',
  )
  // self loop
  assert.throws(
    () => new Planner(cyclic([{ id: 'a', next: 'a', machines: ['M1'], cycle: 10 }])),
    (err) => err.code === 'CYCLIC_ROUTE',
  )
})

test('linked-list route is followed in next order', () => {
  const planner = new Planner({
    calendar: baseCalendar,
    machines: [{ id: 'M1' }, { id: 'M2' }],
    orders: [{
      id: 'O1', product: 'P', quantity: 1,
      route: {
        steps: [
          { id: 'second', machines: ['M2'], cycle: 30 },
          { id: 'first', next: 'second', machines: ['M1'], cycle: 30 },
        ],
      },
    }],
  })
  const plan = planner.toJSON()
  assert.deepEqual(opOf(plan, 'O1', 0), { seq: 0, machine: 'M1', start: '2026-01-05T08:00:00.000Z', end: '2026-01-05T08:30:00.000Z', duration: 30 })
  assert.deepEqual(opOf(plan, 'O1', 1), { seq: 1, machine: 'M2', start: '2026-01-05T08:30:00.000Z', end: '2026-01-05T09:00:00.000Z', duration: 30 })
})

test('calendar overlap errors carry CALENDAR_OVERLAP', () => {
  assert.throws(
    () => new Planner({
      calendar: {
        ...baseCalendar,
        downtimes: [
          { start: '2026-01-05T10:00:00Z', end: '2026-01-05T12:00:00Z' },
          { start: '2026-01-05T11:00:00Z', end: '2026-01-05T13:00:00Z' },
        ],
      },
      machines: [{ id: 'M1' }],
    }),
    (err) => err.code === 'CALENDAR_OVERLAP',
  )
  assert.throws(
    () => new Planner({
      calendar: {
        start: '2026-01-05T00:00:00Z',
        days: 1,
        shifts: [
          { days: [1], start: '08:00', end: '12:00' },
          { days: [1], start: '11:00', end: '15:00' },
        ],
      },
      machines: [{ id: 'M1' }],
    }),
    (err) => err.code === 'CALENDAR_OVERLAP',
  )
})

test('infeasible order carries INFEASIBLE', () => {
  assert.throws(
    () => new Planner({
      calendar: baseCalendar,
      machines: [{ id: 'M1' }],
      orders: [{ id: 'O1', product: 'P', quantity: 1, route: [{ machines: ['M1'], cycle: 600 }] }],
    }),
    (err) => err.code === 'INFEASIBLE' && err.details.orderId === 'O1',
  )
})

test('contention priority: due date, then quantity, then id', () => {
  const planner = new Planner({
    calendar: baseCalendar,
    machines: [{ id: 'M1' }],
    orders: [
      // Same due date for all: quantity decides, then id.
      { id: 'OC', product: 'P', quantity: 1, due: '2026-01-05T16:00:00Z', route: [{ machines: ['M1'], cycle: 10 }] },
      { id: 'OA', product: 'P', quantity: 3, due: '2026-01-05T16:00:00Z', route: [{ machines: ['M1'], cycle: 10 }] },
      { id: 'OB', product: 'P', quantity: 1, due: '2026-01-05T16:00:00Z', route: [{ machines: ['M1'], cycle: 10 }] },
      // Earlier due date beats everything.
      { id: 'OZ', product: 'P', quantity: 9, due: '2026-01-05T09:00:00Z', route: [{ machines: ['M1'], cycle: 10 }] },
    ],
  })
  const plan = planner.toJSON()
  assert.equal(opOf(plan, 'OZ', 0).start, '2026-01-05T08:00:00.000Z') // earliest due (90 min)
  assert.equal(opOf(plan, 'OB', 0).start, '2026-01-05T09:30:00.000Z') // qty 1, id OB < OC
  assert.equal(opOf(plan, 'OC', 0).start, '2026-01-05T09:40:00.000Z')
  assert.equal(opOf(plan, 'OA', 0).start, '2026-01-05T09:50:00.000Z') // largest quantity last
})

test('waiting between operations is not counted as processing', () => {
  const planner = new Planner({
    calendar: baseCalendar,
    machines: [{ id: 'M1' }, { id: 'M2' }],
    orders: [
      { id: 'O1', product: 'P', quantity: 1, due: '2026-01-05T10:00:00Z', route: [{ machines: ['M1'], cycle: 60 }] },
      { id: 'O3', product: 'P', quantity: 1, due: '2026-01-05T11:00:00Z', route: [{ machines: ['M1'], cycle: 60 }] },
      {
        id: 'O2', product: 'P', quantity: 1, due: '2026-01-05T12:00:00Z',
        route: [{ machines: ['M2'], cycle: 60 }, { machines: ['M1'], cycle: 60 }],
      },
    ],
  })
  const plan = planner.toJSON()
  // O2 op1 ends 09:00 on M2, but M1 is busy until 10:00: it waits 09:00-10:00.
  const op2 = opOf(plan, 'O2', 1)
  assert.equal(op2.start, '2026-01-05T10:00:00.000Z')
  assert.equal(op2.end, '2026-01-05T11:00:00.000Z')
  assert.equal(op2.duration, 60) // the 60-minute wait is not processing time
})

test('duration scales with quantity (fixed cycle time per unit)', () => {
  const planner = new Planner({
    calendar: baseCalendar,
    machines: [{ id: 'M1' }],
    orders: [{ id: 'O1', product: 'P', quantity: 4, route: [{ machines: ['M1'], cycle: 30 }] }],
  })
  assert.equal(opOf(planner.toJSON(), 'O1', 0).duration, 120)
})

test('undo/redo operate on command groups', () => {
  const planner = new Planner({
    calendar: baseCalendar,
    machines: [{ id: 'M1' }],
    orders: [{ id: 'O1', product: 'P', quantity: 1, route: [{ machines: ['M1'], cycle: 60 }] }],
  })
  const initial = planner.toJSON()

  // One group containing two commands.
  planner.group(() => {
    planner.addOrders([{ id: 'O2', product: 'P', quantity: 1, route: [{ machines: ['M1'], cycle: 60 }] }])
    planner.addOrders([{ id: 'O3', product: 'P', quantity: 1, route: [{ machines: ['M1'], cycle: 60 }] }])
  })
  const grouped = planner.toJSON()
  assert.equal(grouped.orders.length, 3)

  // A single undo reverts the whole group.
  assert.deepEqual(planner.undo(), { ok: true, changed: true })
  assert.deepEqual(planner.toJSON(), initial)
  assert.deepEqual(planner.redo(), { ok: true, changed: true })
  assert.deepEqual(planner.toJSON(), grouped)

  // Separate commands are separate undo units.
  planner.addOrders([{ id: 'O4', product: 'P', quantity: 1, route: [{ machines: ['M1'], cycle: 60 }] }])
  planner.undo()
  assert.equal(planner.toJSON().orders.length, 3)

  // Empty stacks are no-ops.
  const p2 = new Planner({ calendar: baseCalendar, machines: [{ id: 'M1' }] })
  assert.deepEqual(p2.undo(), { ok: true, changed: false })
  assert.deepEqual(p2.redo(), { ok: true, changed: false })
})

test('failed addOrders rolls the group back', () => {
  const planner = new Planner({
    calendar: baseCalendar,
    machines: [{ id: 'M1' }],
    orders: [{ id: 'O1', product: 'P', quantity: 1, route: [{ machines: ['M1'], cycle: 60 }] }],
  })
  const before = planner.snapshot()
  assert.throws(
    () => planner.addOrders([
      { id: 'O2', product: 'P', quantity: 1, route: [{ machines: ['M1'], cycle: 60 }] },
      { id: 'O3', product: 'P', quantity: 1, route: [{ machines: ['M1'], cycle: 10000 }] },
    ]),
    (err) => err.code === 'INFEASIBLE',
  )
  assert.deepEqual(planner.snapshot(), before) // O2 was not committed either
})

test('subtractIntervals never emits zero-length gaps', () => {
  assert.deepEqual(subtractIntervals([[0, 100]], [[0, 50], [50, 100]]), [])
  assert.deepEqual(subtractIntervals([[0, 100]], [[50, 60]]), [[0, 50], [60, 100]])
  assert.deepEqual(subtractIntervals([[0, 50], [50, 100]], [[50, 50]]), [[0, 50], [50, 100]])
})

test('rest days remove shifts from the calendar', () => {
  const planner = new Planner({
    calendar: {
      start: '2026-01-05T00:00:00Z',
      days: 2,
      shifts: [{ days: [1, 2], start: '08:00', end: '16:00' }],
      restDays: ['2026-01-05'],
    },
    machines: [{ id: 'M1' }],
    orders: [{ id: 'O1', product: 'P', quantity: 1, route: [{ machines: ['M1'], cycle: 60 }] }],
  })
  assert.equal(opOf(planner.toJSON(), 'O1', 0).start, '2026-01-06T08:00:00.000Z')
})
