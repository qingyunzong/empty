import test from 'node:test'
import assert from 'node:assert/strict'
import { Planner } from '../src/planner.js'
import { buildCalendar } from '../src/calendar.js'
import { normalizeOrder } from '../src/model.js'
import { busyByMachine, findPlacement } from '../src/scheduler.js'
import { referenceMinDisturbance } from '../src/reference.js'

const MIN = 60000
const at = (iso) => Math.round(Date.parse(iso) / MIN)

function opOf(plan, orderId, seq) {
  const order = plan.orders.find((o) => o.id === orderId)
  assert.ok(order, `order ${orderId} in plan`)
  return order.operations.find((op) => op.seq === seq)
}

// Acceptance 1: two orders, three machines, alternative machines with a
// tie that must be enumerated and resolved by minimal machine-idle change.
test('acceptance 1: alternative machine tie resolved by minimal idle change', () => {
  const planner = new Planner({
    calendar: {
      start: '2026-01-05T00:00:00Z', // Monday
      days: 1,
      shifts: [{ days: [1], start: '08:00', end: '16:00' }],
    },
    machines: [{ id: 'M1' }, { id: 'M2' }, { id: 'M3' }],
    orders: [
      // Given out of priority order on purpose; O1 has the earlier due date.
      {
        id: 'O2', product: 'P2', quantity: 1, due: '2026-01-05T18:00:00Z',
        route: [
          { machines: ['M1'], cycle: 120 },
          { machines: ['M2', 'M3'], cycle: 60 }, // alternative machines
        ],
      },
      {
        id: 'O1', product: 'P1', quantity: 1, due: '2026-01-05T12:00:00Z',
        route: [
          { machines: ['M2'], cycle: 60 },
          { machines: ['M3'], cycle: 60 },
        ],
      },
    ],
  })

  const plan = planner.toJSON()
  // O1 wins contention (earlier due date) and is placed first.
  assert.deepEqual(opOf(plan, 'O1', 0), { seq: 0, machine: 'M2', start: '2026-01-05T08:00:00.000Z', end: '2026-01-05T09:00:00.000Z', duration: 60 })
  assert.deepEqual(opOf(plan, 'O1', 1), { seq: 1, machine: 'M3', start: '2026-01-05T09:00:00.000Z', end: '2026-01-05T10:00:00.000Z', duration: 60 })
  assert.deepEqual(opOf(plan, 'O2', 0), { seq: 0, machine: 'M1', start: '2026-01-05T08:00:00.000Z', end: '2026-01-05T10:00:00.000Z', duration: 120 })

  // O2 op2 is ready at 10:00. Both M2 (idle from 09:00, gap 420) and M3
  // (idle from 10:00, gap 360) allow start 10:00 -> a tie that must be
  // enumerated. M3 strands less idle (300 < 360), so M3 wins.
  const o2op2 = opOf(plan, 'O2', 1)
  assert.equal(o2op2.machine, 'M3')
  assert.equal(o2op2.start, '2026-01-05T10:00:00.000Z')
  assert.equal(o2op2.end, '2026-01-05T11:00:00.000Z')

  // Directly verify the tie enumeration on the same state.
  const busy = busyByMachine(
    planner.placements.filter((p) => !(p.orderId === 'O2' && p.seq === 1)),
    ['M1', 'M2', 'M3'],
  )
  const placement = findPlacement(
    planner.calendar.availability, busy, 60, at('2026-01-05T10:00:00Z'), ['M2', 'M3'],
  )
  assert.equal(placement.tied, 2) // both machines tied at 10:00
  assert.equal(placement.machine, 'M3') // minimal idle change wins
})

// Acceptance 2: downtime intervals squeeze out zero-length gaps; the
// scheduler must skip them and never emit zero-length placements.
test('acceptance 2: downtime squeezes zero-length gaps', () => {
  const planner = new Planner({
    calendar: {
      start: '2026-01-05T00:00:00Z',
      days: 1,
      shifts: [{ days: [1], start: '08:00', end: '16:00' }],
      downtimes: [{ start: '2026-01-05T10:00:00Z', end: '2026-01-05T12:00:00Z' }],
    },
    machines: [{ id: 'M1' }],
    orders: [
      // Ends exactly when the downtime starts: the "gap" between this
      // operation and the downtime is zero-length.
      { id: 'O1', product: 'P1', quantity: 1, due: '2026-01-05T14:00:00Z', route: [{ machines: ['M1'], cycle: 120 }] },
      { id: 'O2', product: 'P2', quantity: 1, due: '2026-01-05T18:00:00Z', route: [{ machines: ['M1'], cycle: 60 }] },
    ],
  })

  const plan = planner.toJSON()
  assert.deepEqual(opOf(plan, 'O1', 0), { seq: 0, machine: 'M1', start: '2026-01-05T08:00:00.000Z', end: '2026-01-05T10:00:00.000Z', duration: 120 })
  // O2 cannot use the zero-length gap at 10:00 nor the downtime; it
  // starts exactly when the line restarts at 12:00.
  assert.deepEqual(opOf(plan, 'O2', 0), { seq: 0, machine: 'M1', start: '2026-01-05T12:00:00.000Z', end: '2026-01-05T13:00:00.000Z', duration: 60 })

  // No zero-length operation ever appears.
  for (const p of planner.placements) assert.ok(p.end > p.start)
  // Idle computation never yields zero-length intervals.
  const idle = busyByMachine(planner.placements, ['M1'])
  for (const list of idle.values()) {
    for (const [s, e] of list) assert.ok(e > s)
  }

  // A downtime covering the whole remaining shift makes orders infeasible.
  assert.throws(
    () => new Planner({
      calendar: {
        start: '2026-01-05T00:00:00Z',
        days: 1,
        shifts: [{ days: [1], start: '08:00', end: '16:00' }],
        downtimes: [{ start: '2026-01-05T08:00:00Z', end: '2026-01-05T16:00:00Z' }],
      },
      machines: [{ id: 'M1' }],
      orders: [{ id: 'O1', product: 'P1', quantity: 1, route: [{ machines: ['M1'], cycle: 60 }] }],
    }),
    (err) => err.code === 'INFEASIBLE',
  )
})

// Acceptance 3: rush-order reschedule with an insufficient disturbance
// budget rolls back untouched, reports a provable deficit, and the
// reported minimum matches a reference algorithm that enumerates all
// feasible start times.
test('acceptance 3: rush reschedule budget rollback verified by reference', () => {
  const config = {
    calendar: {
      start: '2026-01-05T00:00:00Z',
      days: 1,
      shifts: [{ days: [1], start: '08:00', end: '16:30' }],
      downtimes: [
        { start: '2026-01-05T10:00:00Z', end: '2026-01-05T11:00:00Z' },
        { start: '2026-01-05T12:00:00Z', end: '2026-01-05T13:00:00Z' },
        { start: '2026-01-05T14:00:00Z', end: '2026-01-05T15:00:00Z' },
      ],
    },
    machines: [{ id: 'M1' }],
    orders: [
      { id: 'O1', product: 'P1', quantity: 1, due: '2026-01-05T16:00:00Z', route: [{ machines: ['M1'], cycle: 60 }] },
      { id: 'O2', product: 'P2', quantity: 1, due: '2026-01-05T17:00:00Z', route: [{ machines: ['M1'], cycle: 60 }] },
      { id: 'O3', product: 'P3', quantity: 1, due: '2026-01-05T18:00:00Z', route: [{ machines: ['M1'], cycle: 90 }] },
    ],
  }
  const rush = {
    id: 'R1', product: 'PR', quantity: 1, due: '2026-01-05T08:30:00Z',
    route: [{ machines: ['M1'], cycle: 90 }],
  }

  const planner = new Planner(config)
  // Initial layout: O1 08:00-09:00, O2 09:00-10:00, O3 15:00-16:30;
  // idle fragments [11:00,12:00) and [13:00,14:00) are both < 90.
  const before = planner.snapshot()
  const undoDepth = planner.undoStack.length

  // Budget 1 is provably insufficient: minimum disturbance is 2.
  const failed = planner.insertRush(rush, 1)
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'RESCHEDULE_BUDGET_EXCEEDED')
  assert.equal(failed.required, 2)
  assert.equal(failed.budget, 1)
  assert.equal(failed.deficit, 1)

  // State is completely unchanged after the failed reschedule.
  assert.deepEqual(planner.snapshot(), before)
  assert.equal(planner.undoStack.length, undoDepth)

  // The reference algorithm (enumerating ALL feasible start times of
  // every operation) independently proves the minimum disturbance is 2.
  const calendar = buildCalendar(config.calendar)
  const existing = [...planner.orders.values()]
  const rushOrder = normalizeOrder(rush, ['M1'])
  const reference = referenceMinDisturbance(
    calendar.availability, ['M1'], planner.placements, existing, rushOrder,
  )
  assert.equal(reference, 2)
  assert.equal(reference, failed.required)

  // Budget 2 succeeds and disturbs exactly O1 and O2.
  const ok = planner.insertRush(rush, 2)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.disturbed, ['O1', 'O2'])

  const plan = planner.toJSON()
  assert.deepEqual(opOf(plan, 'R1', 0), { seq: 0, machine: 'M1', start: '2026-01-05T08:00:00.000Z', end: '2026-01-05T09:30:00.000Z', duration: 90 })
  assert.deepEqual(opOf(plan, 'O1', 0), { seq: 0, machine: 'M1', start: '2026-01-05T11:00:00.000Z', end: '2026-01-05T12:00:00.000Z', duration: 60 })
  assert.deepEqual(opOf(plan, 'O2', 0), { seq: 0, machine: 'M1', start: '2026-01-05T13:00:00.000Z', end: '2026-01-05T14:00:00.000Z', duration: 60 })
  assert.deepEqual(opOf(plan, 'O3', 0), { seq: 0, machine: 'M1', start: '2026-01-05T15:00:00.000Z', end: '2026-01-05T16:30:00.000Z', duration: 90 })

  // The committed reschedule is one undoable command group.
  assert.equal(planner.undoStack.length, undoDepth + 1)
  planner.undo()
  assert.deepEqual(planner.snapshot(), before)
  planner.redo()
  assert.deepEqual(planner.toJSON(), plan)
})
