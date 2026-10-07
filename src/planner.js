import { buildCalendar, toISO } from './calendar.js'
import { PlanError } from './errors.js'
import { normalizeOrder, comparePriority } from './model.js'
import { busyByMachine, scheduleOrder } from './scheduler.js'
import { combinations } from './util.js'

export class Planner {
  constructor(config) {
    this.calendar = buildCalendar(config.calendar)
    const ids = (config.machines ?? []).map((m) => (typeof m === 'string' ? m : m?.id))
    if (ids.length === 0 || ids.some((id) => typeof id !== 'string' || !id)) {
      throw new PlanError('VALIDATION', 'machines must be a non-empty array of ids')
    }
    if (new Set(ids).size !== ids.length) {
      throw new PlanError('VALIDATION', 'machine ids must be unique')
    }
    this.machineIds = ids
    this.orders = new Map()
    this.placements = []
    this.undoStack = []
    this.redoStack = []
    this._groupDepth = 0
    this._scheduleInitial((config.orders ?? []).map((o) => normalizeOrder(o, this.machineIds)))
  }

  _busy() {
    return busyByMachine(this.placements, this.machineIds)
  }

  _scheduleInitial(orders) {
    for (const o of orders) {
      if (this.orders.has(o.id)) {
        throw new PlanError('VALIDATION', `duplicate order id ${o.id}`)
      }
      this.orders.set(o.id, o)
    }
    // Contention for the same time slots is resolved by priority:
    // due date, then quantity, then id.
    for (const o of [...orders].sort(comparePriority)) {
      if (!scheduleOrder(this.calendar.availability, this._busy(), o, this.placements)) {
        throw new PlanError('INFEASIBLE', `order ${o.id} cannot be scheduled`, { orderId: o.id })
      }
    }
  }

  snapshot() {
    return structuredClone({ orders: [...this.orders.values()], placements: this.placements })
  }

  restore(snap) {
    this.orders = new Map(snap.orders.map((o) => [o.id, o]))
    this.placements = snap.placements
  }

  // Executes fn as one undoable command group. Nested groups join the
  // outermost one; any thrown error rolls the whole group back.
  group(fn) {
    const outer = this._groupDepth === 0
    const snap = outer ? this.snapshot() : null
    this._groupDepth++
    try {
      const result = fn()
      if (outer) {
        this.undoStack.push(snap)
        this.redoStack = []
      }
      return result
    } catch (err) {
      if (outer) this.restore(snap)
      throw err
    } finally {
      this._groupDepth--
    }
  }

  undo() {
    if (this.undoStack.length === 0) return { ok: true, changed: false }
    this.redoStack.push(this.snapshot())
    this.restore(this.undoStack.pop())
    return { ok: true, changed: true }
  }

  redo() {
    if (this.redoStack.length === 0) return { ok: true, changed: false }
    this.undoStack.push(this.snapshot())
    this.restore(this.redoStack.pop())
    return { ok: true, changed: true }
  }

  addOrders(rawOrders) {
    return this.group(() => {
      const orders = rawOrders.map((o) => normalizeOrder(o, this.machineIds))
      for (const o of orders) {
        if (this.orders.has(o.id)) {
          throw new PlanError('VALIDATION', `duplicate order id ${o.id}`)
        }
      }
      for (const o of orders) this.orders.set(o.id, o)
      for (const o of [...orders].sort(comparePriority)) {
        if (!scheduleOrder(this.calendar.availability, this._busy(), o, this.placements)) {
          throw new PlanError('INFEASIBLE', `order ${o.id} cannot be scheduled`, { orderId: o.id })
        }
      }
      return { ok: true, added: orders.map((o) => o.id) }
    })
  }

  // Incremental reschedule after a rush order. Tries growing disturbance
  // sets (orders to unschedule and re-place) in size order; commits the
  // first feasible one within budget. Over budget: state stays untouched
  // and the provable gap (required - budget) is returned.
  insertRush(rawOrder, budget = 0) {
    if (!Number.isInteger(budget) || budget < 0) {
      throw new PlanError('VALIDATION', 'budget must be a non-negative integer')
    }
    const order = normalizeOrder(rawOrder, this.machineIds)
    if (this.orders.has(order.id)) {
      throw new PlanError('VALIDATION', `duplicate order id ${order.id}`)
    }
    const existingIds = [...this.orders.keys()]
    for (let k = 0; k <= existingIds.length; k++) {
      for (const subset of combinations(existingIds, k)) {
        const trial = this._trial(order, subset)
        if (!trial) continue
        if (k <= budget) {
          this.group(() => {
            this.orders = trial.orders
            this.placements = trial.placements
          })
          return { ok: true, orderId: order.id, disturbed: subset }
        }
        // k is the exact minimum: every subset of size < k was enumerated
        // and failed, so the deficit is provable.
        return {
          ok: false,
          code: 'RESCHEDULE_BUDGET_EXCEEDED',
          orderId: order.id,
          required: k,
          budget,
          deficit: k - budget,
        }
      }
    }
    return {
      ok: false,
      code: 'INFEASIBLE',
      orderId: order.id,
      message: 'rush order cannot be scheduled even if all existing orders are removed',
    }
  }

  // Simulates scheduling the rush order plus re-scheduling the disturbed
  // subset on a throwaway state. Returns null when infeasible.
  _trial(order, removeIds) {
    const removed = new Set(removeIds)
    const orders = new Map(this.orders)
    orders.set(order.id, order)
    const placements = this.placements.filter((p) => !removed.has(p.orderId)).map((p) => ({ ...p }))
    const busy = busyByMachine(placements, this.machineIds)
    if (!scheduleOrder(this.calendar.availability, busy, order, placements)) return null
    const resched = [...this.orders.values()].filter((o) => removed.has(o.id)).sort(comparePriority)
    for (const o of resched) {
      if (!scheduleOrder(this.calendar.availability, busy, o, placements)) return null
    }
    return { orders, placements }
  }

  toJSON() {
    const orders = [...this.orders.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((o) => ({
        id: o.id,
        product: o.product,
        quantity: o.quantity,
        operations: this.placements
          .filter((p) => p.orderId === o.id)
          .sort((a, b) => a.seq - b.seq)
          .map((p) => ({
            seq: p.seq,
            machine: p.machine,
            start: toISO(p.start),
            end: toISO(p.end),
            duration: p.duration,
          })),
      }))
    return { orders }
  }
}
