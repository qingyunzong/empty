import { CODES, PlanError } from './errors.js';

export function compareOrders(a, b) {
  const da = a.due ?? Number.POSITIVE_INFINITY;
  const db = b.due ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  if (a.quantity !== b.quantity) return a.quantity - b.quantity;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function insertBusy(busy, s, e) {
  const out = [];
  let i = 0;
  while (i < busy.length && busy[i][1] <= s) {
    out.push(busy[i]);
    i += 1;
  }
  out.push([s, e]);
  while (i < busy.length) {
    out.push(busy[i]);
    i += 1;
  }
  return out;
}

export function removeBusy(busy, s, e) {
  return busy.filter(([bs, be]) => !(bs === s && be === e));
}

export function spanIdle(calendar, busy) {
  if (busy.length === 0) return 0;
  const busySum = busy.reduce((acc, [bs, be]) => acc + (be - bs), 0);
  return calendar.workingTimeBetween(busy[0][0], busy[busy.length - 1][1]) - busySum;
}

export function idleDelta(calendar, busy, s, durationMs) {
  const e = s + durationMs;
  if (busy.length === 0) return 0;
  const before = spanIdle(calendar, busy);
  const first = Math.min(busy[0][0], s);
  const last = Math.max(busy[busy.length - 1][1], e);
  const busySum = busy.reduce((acc, [bs, be]) => acc + (be - bs), 0) + durationMs;
  return calendar.workingTimeBetween(first, last) - busySum - before;
}

export function scheduleGreedy({ orders, calendar, machineIds }) {
  const busy = new Map(machineIds.map((m) => [m, []]));
  const placements = new Map();
  const decisions = [];
  const sorted = [...orders].sort(compareOrders);
  for (const order of sorted) {
    let release = order.release ?? calendar.start;
    const placed = [];
    for (const op of order.ops) {
      const machines = [op.machine, ...op.alternatives];
      const candidates = [];
      for (const machine of machines) {
        const start = calendar.firstFit(busy.get(machine), release, op.duration);
        if (start !== null) candidates.push({ machine, start });
      }
      if (candidates.length === 0) {
        throw new PlanError(
          CODES.INFEASIBLE,
          `no capacity for operation ${op.opId} of order ${order.id} within the planning horizon`,
          { orderId: order.id, opId: op.opId },
        );
      }
      const tMin = Math.min(...candidates.map((c) => c.start));
      const tied = candidates.filter((c) => c.start === tMin);
      let chosen;
      if (tied.length === 1) {
        chosen = tied[0];
      } else {
        const scored = tied.map((c) => ({
          ...c,
          idleDelta: idleDelta(calendar, busy.get(c.machine), c.start, op.duration),
        }));
        scored.sort((a, b) => a.idleDelta - b.idleDelta || (a.machine < b.machine ? -1 : 1));
        chosen = scored[0];
        decisions.push({
          orderId: order.id,
          opId: op.opId,
          chosen: { machine: chosen.machine, start: chosen.start },
          candidates: scored,
        });
      }
      busy.set(chosen.machine, insertBusy(busy.get(chosen.machine), chosen.start, chosen.start + op.duration));
      placed.push({
        opId: op.opId,
        machine: chosen.machine,
        start: chosen.start,
        end: chosen.start + op.duration,
        duration: op.duration,
      });
      release = chosen.start + op.duration;
    }
    if (order.deadline !== undefined && release > order.deadline) {
      throw new PlanError(CODES.INFEASIBLE, `order ${order.id} cannot meet its deadline`, {
        orderId: order.id,
        deadline: new Date(order.deadline).toISOString(),
      });
    }
    placements.set(order.id, placed);
  }
  return { placements, decisions };
}
