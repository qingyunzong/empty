import { insertBusy } from './scheduler.js';

class CapExceeded extends Error {}

function removeBusy(busy, s, e) {
  return busy.filter(([bs, be]) => !(bs === s && be === e));
}

// Reference scheduler: enumerates all semi-active schedules (every feasible
// start time per operation/machine, plus baseline start times so that
// "undisturbed" placements are always reachable). Used to validate the greedy
// scheduler and to prove the minimum number of disturbed orders.
export function enumerateSchedules({
  orders,
  calendar,
  machineIds,
  baseline = null,
  nodeCap = 200_000,
  collect = false,
}) {
  const busy = new Map(machineIds.map((m) => [m, []]));
  const placements = new Map(orders.map((o) => [o.id, []]));
  const progress = new Map(orders.map((o) => [o.id, 0]));
  const disturbedFlag = new Map(orders.map((o) => [o.id, false]));
  const totalOps = orders.reduce((n, o) => n + o.ops.length, 0);
  let disturbedCount = 0;
  let nodes = 0;
  let proven = true;
  let best = null;
  const collected = [];

  const baselineOf = (orderId, opIdx) => baseline?.get(orderId)?.[opIdx] ?? null;

  function candidateStarts(order, opIdx, op, machine, release) {
    const starts = new Set();
    for (const [fs, fe] of calendar.freeIntervalsFrom(busy.get(machine), release)) {
      const s = Math.max(fs, release);
      if (s + op.duration <= fe) starts.add(s);
    }
    const b = baselineOf(order.id, opIdx);
    if (b && b.machine === machine && b.start >= release) {
      for (const [fs, fe] of calendar.freeIntervalsFrom(busy.get(machine), b.start)) {
        if (fs > b.start) break;
        if (b.start >= fs && b.start + op.duration <= fe) {
          starts.add(b.start);
          break;
        }
      }
    }
    return [...starts].sort((a, b2) => a - b2);
  }

  function dfs(placed) {
    if (placed === totalOps) {
      const snapshot = structuredClone(placements);
      if (collect) collected.push({ disturbed: disturbedCount, placements: snapshot });
      if (!best || disturbedCount < best.disturbed) {
        best = { disturbed: disturbedCount, placements: snapshot };
      }
      return;
    }
    if (!collect && best && disturbedCount >= best.disturbed) return;
    nodes += 1;
    if (nodes > nodeCap) {
      proven = false;
      throw new CapExceeded();
    }
    for (const order of orders) {
      const idx = progress.get(order.id);
      if (idx >= order.ops.length) continue;
      const op = order.ops[idx];
      const release = idx === 0
        ? (order.release ?? calendar.start)
        : placements.get(order.id)[idx - 1].end;
      for (const machine of [op.machine, ...op.alternatives]) {
        for (const s of candidateStarts(order, idx, op, machine, release)) {
          if (order.deadline !== undefined && idx === order.ops.length - 1 && s + op.duration > order.deadline) {
            continue;
          }
          busy.set(machine, insertBusy(busy.get(machine), s, s + op.duration));
          placements.get(order.id)[idx] = {
            opId: op.opId,
            machine,
            start: s,
            end: s + op.duration,
            duration: op.duration,
          };
          progress.set(order.id, idx + 1);
          const b = baselineOf(order.id, idx);
          const inBaseline = baseline !== null && baseline.has(order.id);
          const isDisturbed = inBaseline && (!b || b.machine !== machine || b.start !== s);
          const prevFlag = disturbedFlag.get(order.id);
          if (isDisturbed && !prevFlag) {
            disturbedFlag.set(order.id, true);
            disturbedCount += 1;
          }
          dfs(placed + 1);
          if (isDisturbed && !prevFlag) {
            disturbedFlag.set(order.id, false);
            disturbedCount -= 1;
          }
          progress.set(order.id, idx);
          placements.get(order.id).length = idx;
          busy.set(machine, removeBusy(busy.get(machine), s, s + op.duration));
        }
      }
    }
  }

  try {
    dfs(0);
  } catch (e) {
    if (!(e instanceof CapExceeded)) throw e;
  }
  return { proven, nodes, best, collected };
}
