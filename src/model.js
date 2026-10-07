import { PlanError } from './errors.js'
import { parseInstant } from './calendar.js'

// Resolves a route into an ordered step array.
// Route forms:
//   [step, step, ...]                 implicit linear order
//   { steps: [{id, next, ...}, ...] } explicit chain, cycles detected
function resolveRoute(route, orderId) {
  if (Array.isArray(route)) {
    if (route.length === 0) {
      throw new PlanError('VALIDATION', `order ${orderId}: route must not be empty`)
    }
    return route
  }
  if (route && Array.isArray(route.steps)) {
    const steps = route.steps
    if (steps.length === 0) {
      throw new PlanError('VALIDATION', `order ${orderId}: route must not be empty`)
    }
    const byId = new Map()
    for (const step of steps) {
      if (typeof step?.id !== 'string' || !step.id) {
        throw new PlanError('VALIDATION', `order ${orderId}: every route step needs a non-empty id`)
      }
      if (byId.has(step.id)) {
        throw new PlanError('VALIDATION', `order ${orderId}: duplicate route step id ${step.id}`)
      }
      byId.set(step.id, step)
    }
    for (const step of steps) {
      if (step.next != null && !byId.has(step.next)) {
        throw new PlanError('VALIDATION', `order ${orderId}: route step ${step.id} references unknown next step ${step.next}`)
      }
    }
    const referenced = new Set(steps.map((s) => s.next).filter((n) => n != null))
    const starts = steps.filter((s) => !referenced.has(s.id))
    if (starts.length === 0) {
      throw new PlanError('CYCLIC_ROUTE', `order ${orderId}: route has no entry step (cycle)`)
    }
    if (starts.length > 1) {
      throw new PlanError('VALIDATION', `order ${orderId}: route has multiple entry steps`)
    }
    const ordered = []
    const visited = new Set()
    let cur = starts[0]
    while (cur) {
      if (visited.has(cur.id)) {
        throw new PlanError('CYCLIC_ROUTE', `order ${orderId}: route contains a cycle at step ${cur.id}`)
      }
      visited.add(cur.id)
      ordered.push(cur)
      cur = cur.next != null ? byId.get(cur.next) : null
    }
    if (ordered.length !== steps.length) {
      for (const step of steps) {
        if (visited.has(step.id)) continue
        const seen = new Set()
        let node = step
        while (node && !seen.has(node.id)) {
          seen.add(node.id)
          node = node.next != null ? byId.get(node.next) : null
        }
        if (node) {
          throw new PlanError('CYCLIC_ROUTE', `order ${orderId}: route contains a cycle at step ${node.id}`)
        }
      }
      throw new PlanError('VALIDATION', `order ${orderId}: route is disconnected`)
    }
    return ordered
  }
  throw new PlanError('VALIDATION', `order ${orderId}: route must be an array of steps or { steps: [...] }`)
}

// Normalizes and validates a raw order. Step duration = cycle * quantity.
export function normalizeOrder(raw, machineIds) {
  if (!raw || typeof raw !== 'object') {
    throw new PlanError('VALIDATION', 'order must be an object')
  }
  const { id, product, quantity } = raw
  if (typeof id !== 'string' || !id) {
    throw new PlanError('VALIDATION', 'order.id must be a non-empty string')
  }
  if (typeof product !== 'string' || !product) {
    throw new PlanError('VALIDATION', `order ${id}: product must be a non-empty string`)
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new PlanError('VALIDATION', `order ${id}: quantity must be a positive integer`)
  }
  const due = raw.due == null ? null : parseInstant(raw.due, `order ${id}.due`)
  const release = raw.release == null ? 0 : parseInstant(raw.release, `order ${id}.release`)
  const steps = resolveRoute(raw.route, id).map((step, i) => {
    const machines = step?.machines ?? (step?.machine ? [step.machine] : null)
    if (!Array.isArray(machines) || machines.length === 0) {
      throw new PlanError('VALIDATION', `order ${id} step ${i}: machines must be a non-empty array`)
    }
    for (const m of machines) {
      if (!machineIds.includes(m)) {
        throw new PlanError('VALIDATION', `order ${id} step ${i}: unknown machine ${m}`)
      }
    }
    if (typeof step.cycle !== 'number' || !(step.cycle > 0)) {
      throw new PlanError('VALIDATION', `order ${id} step ${i}: cycle must be a positive number (minutes per unit)`)
    }
    return { machines: [...new Set(machines)], cycle: step.cycle, duration: step.cycle * quantity }
  })
  return { id, product, quantity, due, release, steps }
}

// Contention priority: earlier due date, then smaller quantity, then id.
export function comparePriority(a, b) {
  const da = a.due ?? Infinity
  const db = b.due ?? Infinity
  if (da !== db) return da - db
  if (a.quantity !== b.quantity) return a.quantity - b.quantity
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
