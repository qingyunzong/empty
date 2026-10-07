import {
  makeOrderCompare,
  topoOrder,
  compareSolutions,
  quotaOf,
} from './model.js';

const DEFAULT_NODE_BUDGET = 200000;

// Exact deterministic solver: branch and bound over a topological instruction
// order, maximising (epSum, count, amountSum) with a deterministic assignment
// vector tie-break. Falls back to a deterministic greedy pass if the node
// budget is exceeded (never for small n).
export function solve({ instructions, slots, capacity, quotas, agingFactor, nodeBudget = DEFAULT_NODE_BUDGET }) {
  const compare = makeOrderCompare(agingFactor);
  const order = topoOrder(instructions, compare);
  const n = order.length;
  const ep = order.map((inst) => inst.priority + agingFactor * inst.age);
  const remainingEp = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    remainingEp[i] = remainingEp[i + 1] + Math.max(0, ep[i]);
  }
  const slotLoad = new Array(slots + 1).fill(0);
  const instUse = new Map();
  const current = new Map();
  let best = null;
  let nodes = 0;
  let exceeded = false;

  function dfs(idx, epSum, count, amountSum) {
    if (exceeded) return;
    nodes += 1;
    if (nodes > nodeBudget) {
      exceeded = true;
      return;
    }
    if (best) {
      if (epSum + remainingEp[idx] < best.epSum) return;
      if (epSum + remainingEp[idx] === best.epSum && count + (n - idx) < best.count) return;
    }
    if (idx === n) {
      const candidate = { epSum, count, amountSum, assignments: current };
      if (!best || compareSolutions(candidate, best) < 0) {
        best = { epSum, count, amountSum, assignments: new Map(current) };
      }
      return;
    }
    const inst = order[idx];
    let minSlot = 1;
    let depsOk = true;
    for (const dep of inst.deps) {
      if (!current.has(dep)) {
        depsOk = false;
        break;
      }
      const depSlot = current.get(dep);
      if (depSlot + 1 > minSlot) minSlot = depSlot + 1;
    }
    if (depsOk && (instUse.get(inst.institution) ?? 0) < quotaOf(quotas, inst.institution)) {
      for (let s = minSlot; s <= inst.deadline; s += 1) {
        if (slotLoad[s] < capacity) {
          slotLoad[s] += 1;
          instUse.set(inst.institution, (instUse.get(inst.institution) ?? 0) + 1);
          current.set(inst.id, s);
          dfs(idx + 1, epSum + ep[idx], count + 1, amountSum + inst.amount);
          current.delete(inst.id);
          instUse.set(inst.institution, instUse.get(inst.institution) - 1);
          slotLoad[s] -= 1;
          if (exceeded) return;
        }
      }
    }
    dfs(idx + 1, epSum, count, amountSum);
  }

  dfs(0, 0, 0, 0);
  if (exceeded) {
    return { assignments: greedySolve({ instructions, slots, capacity, quotas, agingFactor }), exact: false, nodes };
  }
  return { assignments: best.assignments, exact: true, nodes };
}

// Deterministic greedy placement in topological order: earliest feasible slot.
export function greedySolve({ instructions, slots, capacity, quotas, agingFactor }) {
  const compare = makeOrderCompare(agingFactor);
  const order = topoOrder(instructions, compare);
  const slotLoad = new Array(slots + 1).fill(0);
  const instUse = new Map();
  const assignments = new Map();
  for (const inst of order) {
    let minSlot = 1;
    let depsOk = true;
    for (const dep of inst.deps) {
      if (!assignments.has(dep)) {
        depsOk = false;
        break;
      }
      const depSlot = assignments.get(dep);
      if (depSlot + 1 > minSlot) minSlot = depSlot + 1;
    }
    if (!depsOk) continue;
    if ((instUse.get(inst.institution) ?? 0) >= quotaOf(quotas, inst.institution)) continue;
    for (let s = minSlot; s <= inst.deadline; s += 1) {
      if (slotLoad[s] < capacity) {
        slotLoad[s] += 1;
        instUse.set(inst.institution, (instUse.get(inst.institution) ?? 0) + 1);
        assignments.set(inst.id, s);
        break;
      }
    }
  }
  return assignments;
}
