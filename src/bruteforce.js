import {
  idCompare,
  makeOrderCompare,
  topoOrder,
  compareSolutions,
  quotaOf,
} from './model.js';

// Independent exhaustive enumerator used to cross-check the branch-and-bound
// solver on small instances (n <= 8). Enumerates every subset by bitmask and
// every slot assignment per subset, keeping the best solution under the same
// deterministic total order.
export function bruteForceSolve({ instructions, slots, capacity, quotas, agingFactor }) {
  const byId = [...instructions].sort((a, b) => idCompare(a.id, b.id));
  const n = byId.length;
  let best = null;

  function consider(epSum, count, amountSum, assignments) {
    const candidate = { epSum, count, amountSum, assignments };
    if (!best || compareSolutions(candidate, best) < 0) {
      best = { epSum, count, amountSum, assignments: new Map(assignments) };
    }
  }

  const total = 1 << n;
  for (let mask = 0; mask < total; mask += 1) {
    const chosen = [];
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) chosen.push(byId[i]);
    }
    const inSet = new Set(chosen.map((c) => c.id));
    let ok = true;
    for (const c of chosen) {
      for (const dep of c.deps) {
        if (!inSet.has(dep)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    const perInst = new Map();
    for (const c of chosen) {
      const used = (perInst.get(c.institution) ?? 0) + 1;
      perInst.set(c.institution, used);
      if (used > quotaOf(quotas, c.institution)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const compare = makeOrderCompare(agingFactor);
    const ordered = topoOrder(chosen, compare);
    const slotLoad = new Array(slots + 1).fill(0);
    const assignments = new Map();
    const epSum = chosen.reduce((acc, c) => acc + c.priority + agingFactor * c.age, 0);
    const amountSum = chosen.reduce((acc, c) => acc + c.amount, 0);

    function enumerate(idx) {
      if (idx === ordered.length) {
        consider(epSum, chosen.length, amountSum, assignments);
        return;
      }
      const inst = ordered[idx];
      let minSlot = 1;
      for (const dep of inst.deps) {
        const depSlot = assignments.get(dep);
        if (depSlot + 1 > minSlot) minSlot = depSlot + 1;
      }
      for (let s = minSlot; s <= inst.deadline; s += 1) {
        if (slotLoad[s] < capacity) {
          slotLoad[s] += 1;
          assignments.set(inst.id, s);
          enumerate(idx + 1);
          assignments.delete(inst.id);
          slotLoad[s] -= 1;
        }
      }
    }
    enumerate(0);
  }
  return best;
}
