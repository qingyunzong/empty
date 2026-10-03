'use strict';

// Maintenance work-order planner core.
//
// Model (all times are integer minutes, intervals are half-open [start, end)):
//  - order: { id, duration, window: [start, end], parts: [partName], skill }
//  - tech:  { id, shifts: [[start, end]], skills: [skill] }
//  - kit:   { id, qty, compatible: [partName] }
//  - an order occupies one tech and one unit of a compatible kit per part for
//    its whole execution interval; kits are returned at `end` and can be
//    reused by later orders (cross-order coupling).
//  - overtime = order minutes not covered by any shift of the assigned tech.
//  - switches = sum over techs of max(0, assignedOrders - 1).
//  - order start times are quantized to window.start + k*timeStep, plus the
//    latest feasible start (window.end - duration); timeStep defaults to 1.
// Objective (lexicographic): maximize completed, minimize overtime, minimize
// switches. All tied optima can be enumerated.

class PlannerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
    this.details = details;
  }
}

function schemaError(message, details) {
  return new PlannerError('ERR_SCHEMA', message, details);
}

function checkWindow(owner, window) {
  if (!Array.isArray(window) || window.length !== 2 || !window.every(Number.isInteger)) {
    throw schemaError(`${owner}: window must be a [start, end] pair of integers`);
  }
  const [start, end] = window;
  if (end < start) {
    throw new PlannerError(
      'ERR_WINDOW',
      `${owner}: window end ${end} is earlier than start ${start}`,
      { owner, window: [start, end] },
    );
  }
  return [start, end];
}

function validate(instance) {
  if (instance === null || typeof instance !== 'object' || Array.isArray(instance)) {
    throw schemaError('instance must be an object with orders, techs and kits arrays');
  }
  const { orders, techs, kits } = instance;
  if (!Array.isArray(orders) || !Array.isArray(techs) || !Array.isArray(kits)) {
    throw schemaError('instance must provide arrays: orders, techs, kits');
  }
  let timeStep;
  if (instance.timeStep !== undefined) {
    if (!Number.isInteger(instance.timeStep) || instance.timeStep <= 0) {
      throw schemaError('timeStep must be a positive integer');
    }
    timeStep = instance.timeStep;
  }

  const normOrders = orders.map((order, index) => {
    if (order === null || typeof order !== 'object' || Array.isArray(order)) {
      throw schemaError(`orders[${index}] must be an object`);
    }
    const id = order.id === undefined ? `O${index}` : String(order.id);
    if (!Number.isInteger(order.duration) || order.duration <= 0) {
      throw schemaError(`order ${id}: duration must be a positive integer`, { order: id });
    }
    const window = checkWindow(`order ${id}`, order.window);
    if (!Array.isArray(order.parts) || order.parts.some((p) => typeof p !== 'string')) {
      throw schemaError(`order ${id}: parts must be an array of part names`, { order: id });
    }
    if (typeof order.skill !== 'string' || order.skill.length === 0) {
      throw schemaError(`order ${id}: skill must be a non-empty string`, { order: id });
    }
    return { id, duration: order.duration, window, parts: [...order.parts], skill: order.skill };
  });
  checkDuplicateIds(normOrders, 'order');

  const normTechs = techs.map((tech, index) => {
    if (tech === null || typeof tech !== 'object' || Array.isArray(tech)) {
      throw schemaError(`techs[${index}] must be an object`);
    }
    const id = tech.id === undefined ? `T${index}` : String(tech.id);
    if (!Array.isArray(tech.shifts)) {
      throw schemaError(`tech ${id}: shifts must be an array of [start, end] pairs`, { tech: id });
    }
    const shifts = tech.shifts.map((shift, i) => checkWindow(`tech ${id} shift ${i}`, shift));
    if (!Array.isArray(tech.skills) || tech.skills.some((s) => typeof s !== 'string')) {
      throw schemaError(`tech ${id}: skills must be an array of strings`, { tech: id });
    }
    return { id, shifts, skills: [...tech.skills] };
  });
  checkDuplicateIds(normTechs, 'tech');

  const normKits = kits.map((kit, index) => {
    if (kit === null || typeof kit !== 'object' || Array.isArray(kit)) {
      throw schemaError(`kits[${index}] must be an object`);
    }
    const id = kit.id === undefined ? `K${index}` : String(kit.id);
    if (!Number.isInteger(kit.qty) || kit.qty < 0) {
      throw schemaError(`kit ${id}: qty must be a non-negative integer`, { kit: id });
    }
    if (!Array.isArray(kit.compatible) || kit.compatible.some((p) => typeof p !== 'string')) {
      throw schemaError(`kit ${id}: compatible must be an array of part names`, { kit: id });
    }
    return { id, qty: kit.qty, compatible: [...kit.compatible] };
  });
  checkDuplicateIds(normKits, 'kit');

  return { orders: normOrders, techs: normTechs, kits: normKits, timeStep };
}

function checkDuplicateIds(items, kind) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw schemaError(`duplicate ${kind} id: ${item.id}`, { id: item.id });
    seen.add(item.id);
  }
}

function mergeIntervals(intervals) {
  const sorted = intervals.map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

function coveredMinutes(mergedShifts, start, end) {
  let covered = 0;
  for (const [s, e] of mergedShifts) {
    if (e <= start) continue;
    if (s >= end) break;
    covered += Math.min(e, end) - Math.max(s, start);
  }
  return covered;
}

function overlapsAny(intervals, start, end) {
  return intervals.some(([a, b]) => a < end && start < b);
}

// Peak concurrent usage of `intervals` inside [start, end).
function maxConcurrent(intervals, start, end) {
  const points = [start];
  for (const [a] of intervals) {
    if (a > start && a < end) points.push(a);
  }
  let max = 0;
  for (const t of points) {
    let count = 0;
    for (const [a, b] of intervals) {
      if (a <= t && t < b) count += 1;
    }
    if (count > max) max = count;
  }
  return max;
}

function compareObjectives(a, b) {
  if (a.completed !== b.completed) return a.completed - b.completed;
  if (a.overtime !== b.overtime) return b.overtime - a.overtime;
  return b.switches - a.switches;
}

function canonicalAssignmentKey(assignments) {
  const sorted = [...assignments].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  return JSON.stringify(
    sorted.map((a) => [a.order, a.tech, a.start, a.kits.map((k) => `${k.part}=${k.kit}`)]),
  );
}

function solve(instance, options = {}) {
  const inst = validate(instance);
  const requireAll = Boolean(options.requireAll);
  const enumerate = Boolean(options.enumerate);
  const maxOptima = options.maxOptima === undefined ? 1024 : options.maxOptima;
  const nodeLimit = options.nodeLimit === undefined ? Number.POSITIVE_INFINITY : options.nodeLimit;
  const findFirst = Boolean(options.findFirst);
  const locks = options.locks || {};
  const timeStep = options.timeStep === undefined ? (inst.timeStep === undefined ? 1 : inst.timeStep) : options.timeStep;
  if (!Number.isInteger(timeStep) || timeStep <= 0) {
    throw new PlannerError('ERR_SCHEMA', 'timeStep must be a positive integer');
  }

  const techIndexById = new Map(inst.techs.map((t, i) => [t.id, i]));
  const orderIds = new Set(inst.orders.map((o) => o.id));
  const normalizedLocks = {};
  for (const [orderId, lock] of Object.entries(locks)) {
    if (!orderIds.has(orderId)) {
      throw new PlannerError('ERR_LOCK', `lock references unknown order ${orderId}`, { order: orderId });
    }
    if (!lock || typeof lock !== 'object' || !techIndexById.has(lock.tech)) {
      throw new PlannerError('ERR_LOCK', `lock for order ${orderId} references an unknown tech`, {
        order: orderId,
        tech: lock && lock.tech,
      });
    }
    if (lock.start !== undefined && !Number.isInteger(lock.start)) {
      throw new PlannerError('ERR_LOCK', `lock for order ${orderId} has a non-integer start`, { order: orderId });
    }
    normalizedLocks[orderId] = lock.start === undefined ? { tech: lock.tech } : { tech: lock.tech, start: lock.start };
  }

  const techs = inst.techs.map((t) => ({
    id: t.id,
    skills: t.skills,
    mergedShifts: mergeIntervals(t.shifts),
    intervals: [],
  }));
  const kitQty = new Map(inst.kits.map((k) => [k.id, k.qty]));
  const kitUsage = new Map(inst.kits.map((k) => [k.id, []]));

  function kitsForPart(part) {
    const out = [];
    for (const kit of inst.kits) {
      if (kit.compatible.includes(part)) out.push(kit.id);
    }
    return out;
  }

  function kitChoicesFor(parts) {
    let combos = [[]];
    for (const part of parts) {
      const candidates = kitsForPart(part);
      const next = [];
      for (const combo of combos) {
        for (const kitId of candidates) next.push([...combo, kitId]);
      }
      combos = next;
    }
    const seen = new Set();
    const unique = [];
    for (const combo of combos) {
      const key = combo.join('');
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(combo);
      }
    }
    return unique;
  }

  const orders = inst.orders.map((o) => ({
    ...o,
    techIdxs: inst.techs
      .map((t, i) => (t.skills.includes(o.skill) ? i : -1))
      .filter((i) => i >= 0),
    kitChoices: kitChoicesFor(o.parts),
  }));
  // Locked orders first (forced decisions), then tightest window, then id.
  orders.sort((a, b) => {
    const la = normalizedLocks[a.id] ? 0 : 1;
    const lb = normalizedLocks[b.id] ? 0 : 1;
    if (la !== lb) return la - lb;
    const sa = a.window[1] - a.window[0] - a.duration;
    const sb = b.window[1] - b.window[0] - b.duration;
    if (sa !== sb) return sa - sb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  let nodes = 0;
  let hitLimit = false;
  let best = null;
  const optima = [];
  let truncated = false;
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

  function kitCapacityOk(choice, start, end) {
    const counts = new Map();
    for (const kitId of choice) counts.set(kitId, (counts.get(kitId) || 0) + 1);
    for (const [kitId, extra] of counts) {
      if (extra > kitQty.get(kitId)) return false;
      if (maxConcurrent(kitUsage.get(kitId), start, end) + extra > kitQty.get(kitId)) return false;
    }
    return true;
  }

  function dfs(index, completed, overtime, switches) {
    if (hitLimit) return;
    if (findFirst && best) return;
    nodes += 1;
    if (nodes > nodeLimit) {
      hitLimit = true;
      return;
    }
    if (best) {
      const maxCompleted = completed + (orders.length - index);
      if (maxCompleted < best.objective.completed) return;
      if (maxCompleted === best.objective.completed) {
        if (overtime > best.objective.overtime) return;
        if (overtime === best.objective.overtime) {
          if (switches > best.objective.switches) return;
          if (!enumerate && switches === best.objective.switches) return;
        }
      }
    }
    if (index === orders.length) {
      if (requireAll && completed < orders.length) return;
      const objective = { completed, overtime, switches };
      const cmp = best ? compareObjectives(objective, best.objective) : 1;
      if (cmp > 0) {
        best = { objective, assignments: snapshot() };
        optima.length = 0;
        if (enumerate) optima.push(best.assignments);
      } else if (cmp === 0 && enumerate) {
        if (optima.length < maxOptima) optima.push(snapshot());
        else truncated = true;
      }
      return;
    }
    const order = orders[index];
    const lock = normalizedLocks[order.id];
    const techIdxs = lock ? [techIndexById.get(lock.tech)] : order.techIdxs;
    for (const techIdx of techIdxs) {
      const tech = techs[techIdx];
      if (!tech.skills.includes(order.skill)) continue;
      const starts = lock && lock.start !== undefined
        ? [lock.start]
        : startTimes(order.window, order.duration, timeStep);
      for (const start of starts) {
        const end = start + order.duration;
        if (start < order.window[0] || end > order.window[1]) continue;
        if (overlapsAny(tech.intervals, start, end)) continue;
        for (const choice of order.kitChoices) {
          if (!kitCapacityOk(choice, start, end)) continue;
          const assignment = {
            order: order.id,
            tech: tech.id,
            start,
            end,
            kits: order.parts.map((part, j) => ({ part, kit: choice[j] })),
          };
          tech.intervals.push([start, end]);
          for (const kitId of choice) kitUsage.get(kitId).push([start, end]);
          current.push(assignment);
          const overtimeDelta = order.duration - coveredMinutes(tech.mergedShifts, start, end);
          const switchDelta = tech.intervals.length > 1 ? 1 : 0;
          dfs(index + 1, completed + 1, overtime + overtimeDelta, switches + switchDelta);
          current.pop();
          tech.intervals.pop();
          for (const kitId of choice) kitUsage.get(kitId).pop();
          if (hitLimit || (findFirst && best)) return;
        }
      }
    }
    if (!requireAll && !lock) {
      dfs(index + 1, completed, overtime, switches);
    }
  }

  dfs(0, 0, 0, 0);

  if (hitLimit) {
    return {
      status: 'UNKNOWN',
      objective: best ? best.objective : null,
      assignments: best ? best.assignments : null,
      optima: enumerate ? optima : undefined,
      optimaCount: optima.length,
      truncated,
      nodes,
    };
  }
  return {
    status: best === null ? 'UNSAT' : 'OPTIMAL',
    objective: best ? best.objective : null,
    assignments: best ? best.assignments : [],
    optima: enumerate ? optima : undefined,
    optimaCount: optima.length,
    truncated,
    nodes,
  };
}

function startTimes(window, duration, timeStep) {
  const latest = window[1] - duration;
  const out = [];
  for (let s = window[0]; s <= latest; s += timeStep) out.push(s);
  if (out.length === 0 || out[out.length - 1] !== latest) out.push(latest);
  return out;
}

// Stateful convenience wrapper: holds an instance plus a set of locked
// assignments so callers can lock -> re-solve -> unlock -> re-solve.
class Planner {
  constructor(instance, baseOptions = {}) {
    this.instance = validate(instance);
    this.baseOptions = { ...baseOptions };
    this.locks = new Map();
  }

  lock(orderId, lock) {
    const { tech, start } = lock || {};
    this.locks.set(orderId, start === undefined ? { tech } : { tech, start });
    return this;
  }

  unlock(orderId) {
    this.locks.delete(orderId);
    return this;
  }

  solve(options = {}) {
    const locks = {};
    for (const [orderId, lock] of this.locks) locks[orderId] = lock;
    return solve(this.instance, { ...this.baseOptions, ...options, locks });
  }
}

module.exports = {
  Planner,
  PlannerError,
  solve,
  validate,
  canonicalAssignmentKey,
};
