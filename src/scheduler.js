// Core rework scheduler.
//
// Semantics:
// - Atomic allocation: each order is allocated station by station. Tentative
//   holds are written into the shared state as they are created; if any later
//   station of the route cannot be placed (no capacity or no budget), every
//   tentative hold of that order is released and a rollback record is emitted.
//   No partial locks survive a failed route.
// - Preemption: a high-priority order that cannot be placed may preempt
//   normal-priority orders, but only atomically across its complete
//   contiguous station segment (its whole route). If the full route cannot be
//   satisfied even after evicting every contending normal order, nothing is
//   preempted. Evicted normals keep their original arrivalShift (aging) and
//   are re-placed oldest-first; those that fit again are rescheduled, the
//   rest return to the waiting queue.
// - Waiting queue: ordered by priority (high first), then aging (earliest
//   arrivalShift first), then id for determinism.

import { normalizeInput, validateOrders } from './model.js';

const PRIORITY_RANK = { high: 0, normal: 1 };

const byArrival = (a, b) =>
  a.arrivalShift - b.arrivalShift ||
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const byQueue = (a, b) =>
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
  a.arrivalShift - b.arrivalShift ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const byAging = (a, b) =>
  a.arrivalShift - b.arrivalShift ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

class State {
  constructor(norm) {
    this.norm = norm;
    this.stationUsed = new Map();
    this.lineUsed = new Map();
    for (const id of norm.stations.keys()) this.stationUsed.set(id, new Array(norm.shifts).fill(0));
    for (const id of norm.lines.keys()) this.lineUsed.set(id, new Array(norm.shifts).fill(0));
    this.placements = new Map(); // orderId -> placement[]
  }

  fits(step, shift) {
    const station = this.norm.stations.get(step.station);
    const stationRemaining = station.capacity[shift] - this.stationUsed.get(step.station)[shift];
    const lineRemaining = this.norm.lines.get(station.lineId).budget[shift] - this.lineUsed.get(station.lineId)[shift];
    return stationRemaining >= step.minutes && lineRemaining >= step.minutes;
  }

  applyHold(orderId, placement) {
    this.stationUsed.get(placement.station)[placement.shift] += placement.minutes;
    this.lineUsed.get(placement.lineId)[placement.shift] += placement.minutes;
    if (!this.placements.has(orderId)) this.placements.set(orderId, []);
    this.placements.get(orderId).push(placement);
  }

  release(orderId) {
    const held = this.placements.get(orderId) ?? [];
    for (const placement of held) {
      this.stationUsed.get(placement.station)[placement.shift] -= placement.minutes;
      this.lineUsed.get(placement.lineId)[placement.shift] -= placement.minutes;
    }
    this.placements.delete(orderId);
    return held;
  }

  clone() {
    const copy = new State(this.norm);
    for (const [id, used] of this.stationUsed) copy.stationUsed.set(id, [...used]);
    for (const [id, used] of this.lineUsed) copy.lineUsed.set(id, [...used]);
    for (const [id, placements] of this.placements) {
      copy.placements.set(id, placements.map((p) => ({ ...p })));
    }
    return copy;
  }

  adopt(other) {
    this.stationUsed = other.stationUsed;
    this.lineUsed = other.lineUsed;
    this.placements = other.placements;
  }
}

function findShift(state, step, minShift) {
  for (let shift = minShift; shift < state.norm.shifts; shift += 1) {
    if (state.fits(step, shift)) return shift;
  }
  return -1;
}

// Allocates every step of the route, earliest feasible shift first, each step
// at the same or a later shift than the previous one and never before the
// order's arrivalShift. On failure every tentative hold is rolled back.
function tryAllocate(state, order, rollbacks) {
  const holds = [];
  let minShift = order.arrivalShift;
  for (let stepIndex = 0; stepIndex < order.route.length; stepIndex += 1) {
    const step = order.route[stepIndex];
    const shift = findShift(state, step, minShift);
    if (shift === -1) {
      if (holds.length > 0) {
        const released = state.release(order.id).map((p) => ({ ...p }));
        rollbacks.push({
          orderId: order.id,
          reason: 'atomic-rollback',
          failedStep: stepIndex,
          station: step.station,
          released,
        });
      }
      return null;
    }
    const placement = {
      stepIndex,
      station: step.station,
      lineId: state.norm.stations.get(step.station).lineId,
      shift,
      minutes: step.minutes,
    };
    state.applyHold(order.id, placement);
    holds.push(placement);
    minShift = shift;
  }
  return holds;
}

function samePlacements(a, b) {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.station === b[i].station && p.shift === b[i].shift && p.minutes === b[i].minutes);
}

// High-priority preemption. Only normal-priority orders whose placements
// contend with the preemptor's segment (same line, shift >= arrivalShift)
// are candidate victims. The whole route must be placeable after eviction,
// otherwise nothing is preempted (complete contiguous segment or nothing).
function tryPreempt(state, order, ctx) {
  const routeLines = new Set(
    order.route.map((step) => state.norm.stations.get(step.station).lineId),
  );
  const contenders = [];
  for (const [orderId, placements] of state.placements) {
    if (ctx.byId.get(orderId).priority !== 'normal') continue;
    const contends = placements.some((p) => p.shift >= order.arrivalShift && routeLines.has(p.lineId));
    if (contends) contenders.push(orderId);
  }
  if (contenders.length === 0) return false;

  const trial = state.clone();
  const originals = new Map();
  for (const orderId of contenders) {
    originals.set(orderId, state.placements.get(orderId).map((p) => ({ ...p })));
    trial.release(orderId);
  }

  const sink = [];
  const holds = tryAllocate(trial, order, sink);
  if (!holds) return false; // full segment not satisfiable: preempt nothing

  // Re-place evicted normals, oldest (most aged) first.
  const evicted = [];
  const rescheduled = [];
  const aged = contenders.map((id) => ctx.byId.get(id)).sort(byAging);
  for (const victim of aged) {
    const replaced = tryAllocate(trial, victim, sink);
    if (!replaced) {
      evicted.push(victim.id);
    } else if (!samePlacements(originals.get(victim.id), replaced)) {
      rescheduled.push(victim.id);
    }
  }

  state.adopt(trial);
  for (const orderId of [...evicted, ...rescheduled]) {
    ctx.rollbacks.push({
      orderId,
      reason: 'preempted',
      preemptedBy: order.id,
      released: originals.get(orderId),
    });
  }
  for (const orderId of evicted) ctx.waiting.push(ctx.byId.get(orderId));
  ctx.preemptions.push({
    orderId: order.id,
    stations: order.route.map((step) => step.station),
    evicted,
    rescheduled,
    steps: holds.map((p) => ({ ...p })),
  });
  return true;
}

export function schedule(input) {
  const norm = normalizeInput(input);
  const { valid, errors } = validateOrders(norm);
  const state = new State(norm);
  const byId = new Map(norm.orders.map((order) => [order.id, order]));
  const rollbacks = [];
  const preemptions = [];
  const waiting = [];
  const ctx = { byId, rollbacks, preemptions, waiting };

  // First pass: arrival order (ties broken by priority, then id).
  for (const order of [...valid].sort(byArrival)) {
    if (tryAllocate(state, order, rollbacks)) continue;
    if (order.priority === 'high' && tryPreempt(state, order, ctx)) continue;
    waiting.push(order);
  }

  // Retry loop for the waiting queue (priority, then aging, then id).
  const sink = [];
  let progress = true;
  while (progress) {
    progress = false;
    waiting.sort(byQueue);
    for (let i = 0; i < waiting.length; i += 1) {
      const order = waiting[i];
      let placed = tryAllocate(state, order, sink) !== null;
      if (!placed && order.priority === 'high') placed = tryPreempt(state, order, ctx);
      if (placed) {
        waiting.splice(i, 1);
        i -= 1;
        progress = true;
      }
    }
  }
  waiting.sort(byQueue);

  const routes = [];
  const budgetDeductions = [];
  for (const order of valid) {
    const placements = state.placements.get(order.id);
    if (!placements) continue;
    const steps = [...placements].sort((a, b) => a.stepIndex - b.stepIndex);
    routes.push({ orderId: order.id, priority: order.priority, arrivalShift: order.arrivalShift, steps });
    for (const p of steps) {
      budgetDeductions.push({
        orderId: order.id,
        stepIndex: p.stepIndex,
        station: p.station,
        lineId: p.lineId,
        shift: p.shift,
        minutes: p.minutes,
      });
    }
  }

  return {
    routes,
    budgetDeductions,
    preemptions,
    rollbacks,
    waiting: waiting.map((order) => order.id),
    errors,
    stationUsage: Object.fromEntries([...state.stationUsed].map(([id, used]) => [id, [...used]])),
    lineUsage: Object.fromEntries([...state.lineUsed].map(([id, used]) => [id, [...used]])),
    summary: {
      scheduled: routes.length,
      waiting: waiting.length,
      errors: errors.length,
      preemptions: preemptions.length,
      rollbacks: rollbacks.length,
    },
  };
}
