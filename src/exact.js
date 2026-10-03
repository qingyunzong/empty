// Exact cardinality-improvement pass. For small instances (n <=
// config.exactThreshold) a deterministic branch-and-bound verifies whether
// more instructions can be confirmed than the greedy+preemption pass
// achieved. Only a strictly larger feasible set is adopted; ties always keep
// the greedy result, so heuristic choices (aging, fairness) are preserved.
import { quotaOf, scoreOf } from './scheduler.js';
import { emitCertificate } from './certificates.js';

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Static topological order (dependencies first); ties by score desc, amount
// desc, deadline asc, id asc. Deterministic.
function topoOrder(state, candidates) {
  const ids = new Set(candidates.map((i) => i.id));
  const indegree = new Map(candidates.map((i) => [i.id, 0]));
  const dependents = new Map(candidates.map((i) => [i.id, []]));
  for (const instr of candidates) {
    for (const dep of instr.dependencies) {
      if (!ids.has(dep)) continue;
      indegree.set(instr.id, indegree.get(instr.id) + 1);
      dependents.get(dep).push(instr.id);
    }
  }
  const byId = state.byId;
  const staticKey = (a, b) => {
    const ia = byId.get(a);
    const ib = byId.get(b);
    const sa = scoreOf(state.config, ia);
    const sb = scoreOf(state.config, ib);
    if (sa !== sb) return sb - sa;
    if (ia.amount !== ib.amount) return ib.amount - ia.amount;
    if (ia.deadlineSlot !== ib.deadlineSlot) return ia.deadlineSlot - ib.deadlineSlot;
    return compareIds(a, b);
  };
  const ready = candidates.filter((i) => indegree.get(i.id) === 0).map((i) => i.id).sort(staticKey);
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(byId.get(id));
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        ready.push(next);
        ready.sort(staticKey);
      }
    }
  }
  // Any leftover (only possible through excluded dependencies) is appended in
  // id order; it will simply never be placeable in the search.
  const placed = new Set(order.map((i) => i.id));
  for (const instr of candidates) {
    if (!placed.has(instr.id)) order.push(instr);
  }
  return order;
}

export function exactImprove(state) {
  const { config } = state;
  const candidates = state.instructions.filter((i) => !state.excluded.has(i.id));
  if (candidates.length === 0 || candidates.length > config.exactThreshold) return;

  const order = topoOrder(state, candidates);
  const cap = config.capacityPerSlot;
  const slotLoad = new Array(config.slots + 1).fill(0);
  const usage = new Map();
  const assign = new Map();

  let bestCount = state.slotOf.size;
  let bestAssign = null;

  const dfs = (k, count) => {
    if (count > bestCount) {
      bestCount = count;
      bestAssign = new Map(assign);
    }
    if (k === order.length) return;
    if (count + (order.length - k) <= bestCount) return;
    const instr = order[k];
    let maxDepSlot = 0;
    let depsOk = true;
    for (const dep of instr.dependencies) {
      const s = assign.get(dep);
      if (s === undefined) { depsOk = false; break; }
      if (s > maxDepSlot) maxDepSlot = s;
    }
    if (depsOk) {
      const lo = Math.max(instr.arrivalSlot, maxDepSlot + 1);
      const quota = quotaOf(config, instr.institution);
      const used = usage.get(instr.institution) ?? 0;
      for (let s = lo; s <= instr.deadlineSlot; s++) {
        if (slotLoad[s] >= cap) continue;
        if (used >= quota) continue;
        assign.set(instr.id, s);
        slotLoad[s] += 1;
        usage.set(instr.institution, used + 1);
        dfs(k + 1, count + 1);
        usage.set(instr.institution, used);
        slotLoad[s] -= 1;
        assign.delete(instr.id);
      }
    }
    dfs(k + 1, count); // skip branch
  };
  dfs(0, 0);

  if (bestAssign === null) return; // greedy is already cardinality-optimal

  // Adopt the strictly better solution, emitting delta certificates so the
  // replay log stays truthful.
  const current = new Map(state.slotOf);
  for (const id of [...current.keys()].sort()) {
    if (bestAssign.get(id) !== current.get(id)) {
      removeForReoptimize(state, id);
    }
  }
  for (const id of [...bestAssign.keys()].sort()) {
    if (!state.slotOf.has(id)) {
      placeForReoptimize(state, id, bestAssign.get(id));
    }
  }
}

function removeForReoptimize(state, id) {
  const slot = state.slotOf.get(id);
  state.slotOf.delete(id);
  const occ = state.occupancy.get(slot);
  occ.splice(occ.indexOf(id), 1);
  const inst = state.byId.get(id).institution;
  state.usage.set(inst, (state.usage.get(inst) ?? 1) - 1);
  state.status.set(id, 'pending');
  emitCertificate(state, { op: 'rollback', instructionId: id, slot, reason: 'reoptimize' });
}

function placeForReoptimize(state, id, slot) {
  state.slotOf.set(id, slot);
  if (!state.occupancy.has(slot)) state.occupancy.set(slot, []);
  state.occupancy.get(slot).push(id);
  const inst = state.byId.get(id).institution;
  state.usage.set(inst, (state.usage.get(inst) ?? 0) + 1);
  state.status.set(id, 'confirmed');
  emitCertificate(state, { op: 'assign', instructionId: id, slot, reason: 'reoptimize' });
}
