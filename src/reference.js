import { busyByMachine, idleIntervals } from './scheduler.js'
import { combinations } from './util.js'

// Reference feasibility check: complete backtracking search that
// enumerates EVERY feasible start time of every operation on every
// allowed machine. Used to validate the greedy planner.
export function canPlaceAll(availability, machineIds, fixedPlacements, orders) {
  const busy = busyByMachine(
    fixedPlacements.map((p) => ({ ...p })),
    machineIds,
  )
  function placeStep(oi, si, ready) {
    if (si === orders[oi].steps.length) return placeOrder(oi + 1)
    const step = orders[oi].steps[si]
    for (const m of step.machines) {
      const idle = idleIntervals(availability, busy.get(m))
      for (const [a, b] of idle) {
        for (let s = Math.max(a, ready); s + step.duration <= b; s++) {
          const list = busy.get(m)
          list.push([s, s + step.duration])
          list.sort((x, y) => x[0] - y[0])
          if (placeStep(oi, si + 1, s + step.duration)) return true
          list.splice(list.findIndex(([x, y]) => x === s && y === s + step.duration), 1)
        }
      }
    }
    return false
  }
  function placeOrder(oi) {
    if (oi === orders.length) return true
    return placeStep(oi, 0, orders[oi].release ?? 0)
  }
  return placeOrder(0)
}

// Exact minimum disturbance: smallest k such that removing some k
// existing orders lets the rush order plus the removed orders be
// re-placed (verified by enumerating all feasible start times).
export function referenceMinDisturbance(availability, machineIds, placements, existingOrders, rushOrder) {
  const ids = existingOrders.map((o) => o.id)
  for (let k = 0; k <= ids.length; k++) {
    for (const subset of combinations(ids, k)) {
      const removed = new Set(subset)
      const fixed = placements.filter((p) => !removed.has(p.orderId))
      const moving = existingOrders.filter((o) => removed.has(o.id))
      if (canPlaceAll(availability, machineIds, fixed, [rushOrder, ...moving])) return k
    }
  }
  return Infinity
}
