import { subtractIntervals } from './calendar.js'

// Builds machine -> sorted busy [[s,e), ...] map from placements.
export function busyByMachine(placements, machineIds) {
  const map = new Map(machineIds.map((id) => [id, []]))
  for (const p of placements) {
    map.get(p.machine).push([p.start, p.end])
  }
  for (const list of map.values()) list.sort((a, b) => a[0] - b[0])
  return map
}

// Machine idle intervals = global availability minus machine busy.
// Zero-length gaps never survive subtraction.
export function idleIntervals(availability, busy) {
  return subtractIntervals(availability, busy)
}

// Finds the earliest feasible placement of one operation.
// When several machines allow the same earliest start (tied schemes),
// all of them are enumerated and the one with the smallest machine-idle
// change wins: leftover = (gap size - duration), i.e. the idle fragment
// stranded in the affected gap. Remaining ties break by machine id.
export function findPlacement(availability, busyMap, duration, ready, machineIds) {
  const candidates = []
  for (const m of machineIds) {
    const idle = idleIntervals(availability, busyMap.get(m) ?? [])
    for (const [a, b] of idle) {
      const s = Math.max(a, ready)
      if (s + duration <= b) {
        candidates.push({ machine: m, start: s, end: s + duration, leftover: (b - a) - duration })
        break
      }
    }
  }
  if (candidates.length === 0) return null
  const minStart = Math.min(...candidates.map((c) => c.start))
  const tied = candidates.filter((c) => c.start === minStart)
  tied.sort((a, b) =>
    a.leftover - b.leftover || (a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0))
  const chosen = tied[0]
  return { machine: chosen.machine, start: chosen.start, end: chosen.end, tied: tied.length }
}

// Places every operation of an order in route order, waiting between
// operations is allowed and never occupies a machine. Mutates busyMap
// and placements; rolls both back and returns null when infeasible.
export function scheduleOrder(availability, busyMap, order, placements) {
  const added = []
  let ready = order.release ?? 0
  for (let seq = 0; seq < order.steps.length; seq++) {
    const step = order.steps[seq]
    const p = findPlacement(availability, busyMap, step.duration, ready, step.machines)
    if (!p) {
      for (const rec of added) {
        const list = busyMap.get(rec.machine)
        list.splice(list.findIndex(([s, e]) => s === rec.start && e === rec.end), 1)
        placements.splice(placements.indexOf(rec), 1)
      }
      return null
    }
    const rec = {
      orderId: order.id,
      seq,
      machine: p.machine,
      start: p.start,
      end: p.end,
      duration: step.duration,
    }
    const list = busyMap.get(p.machine)
    list.push([p.start, p.end])
    list.sort((a, b) => a[0] - b[0])
    placements.push(rec)
    added.push(rec)
    ready = p.end
  }
  return added
}
