'use strict';

// Independent branch-and-bound reference, used only by the test-suite to
// cross-check src/planner.js. It shares no search code with the planner;
// both implement the documented semantics (README.md):
//  - half-open integer-minute intervals [start, end)
//  - start times quantized to window.start + k*timeStep, plus the latest
//    feasible start (window.end - duration)
//  - one tech per order; tech must have the skill and run one order at a time
//  - each part consumes one unit of a compatible kit for [start, end)
//  - overtime = order minutes not covered by the assigned tech's shifts
//  - switches = sum over techs of max(0, assignedOrders - 1)
//  - lexicographic objective: completed desc, overtime asc, switches asc

function mergeShifts(shifts) {
  const sorted = shifts.map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

function coveredMinutes(shifts, start, end) {
  let covered = 0;
  for (const [s, e] of shifts) {
    const lo = Math.max(s, start);
    const hi = Math.min(e, end);
    if (hi > lo) covered += hi - lo;
  }
  return covered;
}

function candidateStarts(order, timeStep) {
  const latest = order.window[1] - order.duration;
  const out = [];
  for (let s = order.window[0]; s <= latest; s += timeStep) out.push(s);
  if (out.length === 0 || out[out.length - 1] !== latest) out.push(latest);
  return out;
}

function solutionKey(assignments) {
  const sorted = [...assignments].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  return JSON.stringify(
    sorted.map((a) => [a.order, a.tech, a.start, a.kits.map((k) => `${k.part}=${k.kit}`)]),
  );
}

function compareObjectives(a, b) {
  if (a.completed !== b.completed) return a.completed - b.completed;
  if (a.overtime !== b.overtime) return b.overtime - a.overtime;
  return b.switches - a.switches;
}

function referenceSolve(instance, options = {}) {
  const timeStep = options.timeStep === undefined
    ? (instance.timeStep === undefined ? 1 : instance.timeStep)
    : options.timeStep;
  const requireAll = Boolean(options.requireAll);

  const techs = instance.techs.map((t) => ({
    id: t.id,
    skills: t.skills,
    shifts: mergeShifts(t.shifts),
    busy: [],
  }));
  const kits = new Map(instance.kits.map((k) => [k.id, { qty: k.qty, usage: [] }]));

  function* kitChoices(parts, index, acc) {
    if (index === parts.length) {
      yield acc;
      return;
    }
    for (const kit of instance.kits) {
      if (!kit.compatible.includes(parts[index])) continue;
      acc.push(kit.id);
      yield* kitChoices(parts, index + 1, acc);
      acc.pop();
    }
  }

  function kitFits(choice, start, end) {
    const need = new Map();
    for (const id of choice) need.set(id, (need.get(id) || 0) + 1);
    for (const [id, extra] of need) {
      const kit = kits.get(id);
      if (extra > kit.qty) return false;
      const points = [start];
      for (const [a] of kit.usage) {
        if (a > start && a < end) points.push(a);
      }
      for (const t of points) {
        let concurrent = 0;
        for (const [a, b] of kit.usage) {
          if (a <= t && t < b) concurrent += 1;
        }
        if (concurrent + extra > kit.qty) return false;
      }
    }
    return true;
  }

  let best = null;
  const optima = new Map();
  let nodes = 0;
  const current = [];

  function snapshot() {
    return current
      .map((a) => ({
        order: a.order,
        tech: a.tech,
        start: a.start,
        end: a.end,
        kits: a.kits.map((k) => ({ part: k.part, kit: k.kit })),
      }))
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  }

  function rec(index, completed, overtime, switches) {
    nodes += 1;
    if (best) {
      const maxCompleted = completed + (instance.orders.length - index);
      if (maxCompleted < best.completed) return;
      if (maxCompleted === best.completed) {
        if (overtime > best.overtime) return;
        if (overtime === best.overtime && switches > best.switches) return;
      }
    }
    if (index === instance.orders.length) {
      if (requireAll && completed < instance.orders.length) return;
      const objective = { completed, overtime, switches };
      const cmp = best ? compareObjectives(objective, best) : 1;
      if (cmp > 0) {
        best = objective;
        optima.clear();
        optima.set(solutionKey(current), snapshot());
      } else if (cmp === 0) {
        optima.set(solutionKey(current), snapshot());
      }
      return;
    }
    const order = instance.orders[index];
    for (const tech of techs) {
      if (!tech.skills.includes(order.skill)) continue;
      for (const start of candidateStarts(order, timeStep)) {
        const end = start + order.duration;
        if (tech.busy.some(([a, b]) => a < end && start < b)) continue;
        for (const choice of kitChoices(order.parts, 0, [])) {
          if (!kitFits(choice, start, end)) continue;
          tech.busy.push([start, end]);
          for (const id of choice) kits.get(id).usage.push([start, end]);
          current.push({
            order: order.id,
            tech: tech.id,
            start,
            end,
            kits: order.parts.map((part, j) => ({ part, kit: choice[j] })),
          });
          const overtimeDelta = order.duration - coveredMinutes(tech.shifts, start, end);
          const switchDelta = tech.busy.length > 1 ? 1 : 0;
          rec(index + 1, completed + 1, overtime + overtimeDelta, switches + switchDelta);
          current.pop();
          tech.busy.pop();
          for (const id of choice) kits.get(id).usage.pop();
        }
      }
    }
    if (!requireAll) rec(index + 1, completed, overtime, switches);
  }

  rec(0, 0, 0, 0);
  return { objective: best, optima: [...optima.values()], nodes };
}

module.exports = { referenceSolve, solutionKey };
