// Exact deterministic scheduler.
//
// Objective (lexicographic): 1) feasible w.r.t. due dates, 2) minimal makespan
// (earliest completion), 3) fewest mold changes, 4) lexicographically smallest
// canonical sequence assignment. Unknown setup entries default to 0 and are
// never treated as infeasible.

export class NodeCap extends Error {}

export function setupTime(instance, from, to) {
  if (from === to) return 0;
  const row = instance.setups[from];
  if (!row) return 0;
  return row[to] ?? 0;
}

// Deterministic event-based serial simulation of fixed per-machine sequences.
// Resources: machine, mold, person -- each used by at most one op at a time.
export function simulate(instance, sequences) {
  const machineFree = {};
  const lastMold = {};
  const remaining = {};
  for (const m of instance.machines) {
    machineFree[m] = 0;
    lastMold[m] = null;
    remaining[m] = [...(sequences[m] ?? [])];
  }
  const moldFree = {};
  const personFree = {};
  const plan = [];
  let changes = 0;
  let makespan = 0;

  for (;;) {
    let best = null;
    for (const m of instance.machines) {
      const oid = remaining[m][0];
      if (oid === undefined) continue;
      const o = instance.orders[oid];
      const setup = lastMold[m] === null ? 0 : setupTime(instance, lastMold[m], o.mold);
      const start = Math.max(
        Math.max(machineFree[m], moldFree[o.mold] ?? 0) + setup,
        personFree[o.person] ?? 0
      );
      if (
        !best ||
        start < best.start ||
        (start === best.start && (m < best.machine || (m === best.machine && oid < best.order)))
      ) {
        best = { machine: m, order: oid, start, setup };
      }
    }
    if (!best) break;
    const o = instance.orders[best.order];
    const end = best.start + o.proc;
    if (lastMold[best.machine] !== null && lastMold[best.machine] !== o.mold) changes++;
    plan.push({ order: best.order, machine: best.machine, setup: best.setup, start: best.start, end });
    machineFree[best.machine] = end;
    moldFree[o.mold] = end;
    personFree[o.person] = end;
    lastMold[best.machine] = o.mold;
    remaining[best.machine].shift();
    if (end > makespan) makespan = end;
  }
  return { plan, makespan, changes, machineFree, lastMold };
}

// Canonical lexicographic comparison of sequence assignments.
export function compareSequences(a, b, machines) {
  for (const m of machines) {
    const xa = a[m] ?? [];
    const xb = b[m] ?? [];
    const n = Math.min(xa.length, xb.length);
    for (let i = 0; i < n; i++) {
      if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
    }
    if (xa.length !== xb.length) return xa.length < xb.length ? -1 : 1;
  }
  return 0;
}

function greedyFallback(instance, sortedIds) {
  const seqs = Object.fromEntries(instance.machines.map((m) => [m, []]));
  for (const oid of sortedIds) {
    let bestM = null;
    let bestKey = null;
    for (const m of instance.machines) {
      seqs[m].push(oid);
      const sim = simulate(instance, seqs);
      const key = [sim.makespan, sim.changes, m];
      if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
        bestKey = key;
        bestM = m;
      }
      seqs[m].pop();
    }
    seqs[bestM].push(oid);
  }
  const sim = simulate(instance, seqs);
  const feasible = sim.plan.every((op) => op.end <= instance.orders[op.order].due);
  return {
    status: feasible ? "fallback" : "infeasible",
    sequences: seqs,
    makespan: sim.makespan,
    changes: sim.changes,
    plan: sim.plan,
  };
}

// Exact solve: branch & bound for the optimal objective, then greedy
// lexicographic reconstruction guided by bounded existence checks.
export function solve(instance, orderIds, opts = {}) {
  const machines = instance.machines;
  const m = machines.length;
  const sortedIds = [...orderIds].sort();
  const CAP = opts.nodeCap ?? 1_000_000;
  let nodes = 0;

  const seqs = Object.fromEntries(machines.map((mm) => [mm, []]));
  const remaining = new Set(sortedIds);

  const feasiblePartial = (sim) => sim.plan.every((op) => op.end <= instance.orders[op.order].due);

  // Single-machine dominance memoization (exact subset-DP equivalence).
  const nIds = sortedIds.length;
  const useMemo = m === 1 && nIds <= 30;
  const idxOf = new Map(sortedIds.map((id, i) => [id, i]));
  const moldIdx = new Map(Object.keys(instance.molds).sort().map((f, i) => [f, i]));
  const moldSlots = moldIdx.size + 1;
  let remMask = useMemo ? (1 << nIds) - 1 : 0;
  const memoExplore = new Map(); // key -> pareto [[free, changes], ...]
  const memoFailed = new Map(); // key -> pareto of failed [[free, changes], ...]
  const memoKey = (sim) => {
    const lm = sim.lastMold[machines[0]];
    return remMask * moldSlots + (lm === null ? moldSlots - 1 : moldIdx.get(lm));
  };
  const dominated = (list, f, c) => list.some(([ef, ec]) => ef <= f && ec <= c);
  const addPareto = (list, f, c) => {
    for (let i = list.length - 1; i >= 0; i--) if (list[i][0] >= f && list[i][1] >= c) list.splice(i, 1);
    list.push([f, c]);
  };

  // minEntry[f]: cheapest known changeover into mold f (unknown entries are 0).
  const minEntry = {};
  for (const f of Object.keys(instance.molds)) {
    let best = Infinity;
    for (const g of Object.keys(instance.molds)) {
      if (g === f) continue;
      const t = setupTime(instance, g, f);
      if (t < best) best = t;
    }
    minEntry[f] = best === Infinity ? 0 : best;
  }

  // Valid lower bounds on the final (makespan, changes).
  const lowerBound = (sim, remSet) => {
    let work = 0;
    for (const mm of machines) work += sim.machineFree[mm];
    let rem = 0;
    const remMolds = new Set();
    for (const id of remSet) {
      rem += instance.orders[id].proc;
      remMolds.add(instance.orders[id].mold);
    }
    const loaded = new Set();
    let freshMachines = 0;
    for (const mm of machines) {
      if (sim.lastMold[mm] !== null) loaded.add(sim.lastMold[mm]);
      else freshMachines += 1;
    }
    // Molds not currently loaded must be entered at least once, but each
    // never-used machine absorbs one mold entry for free (no changeover).
    const entries = [];
    for (const f of remMolds) if (!loaded.has(f)) entries.push(minEntry[f]);
    entries.sort((a, b) => b - a);
    let setupWork = 0;
    for (let i = freshMachines; i < entries.length; i++) setupWork += entries[i];
    const extraChanges = Math.max(0, entries.length - freshMachines);
    const avg = (work + rem + setupWork) / m;
    let lbMakespan = avg > sim.makespan ? avg : sim.makespan;
    // Each remaining order j completes no earlier than its cheapest placement.
    for (const id of remSet) {
      const o = instance.orders[id];
      let best = Infinity;
      for (const mm of machines) {
        const lm = sim.lastMold[mm];
        const s = lm === null ? 0 : setupTime(instance, lm, o.mold);
        const t = sim.machineFree[mm] + s + o.proc;
        if (t < best) best = t;
      }
      if (best > lbMakespan) lbMakespan = best;
    }
    return { makespan: lbMakespan, changes: sim.changes + extraChanges };
  };

  // Phase-1 child ordering: earliest-due orders first, least-loaded machine first.
  const edfIds = [...sortedIds].sort((a, b) => instance.orders[a].due - instance.orders[b].due || (a < b ? -1 : 1));

  // Phase 1: optimal (makespan, changes).
  let bestObj = null;
  function dfs1() {
    if (++nodes > CAP) throw new NodeCap();
    const sim = simulate(instance, seqs);
    if (!feasiblePartial(sim)) return;
    if (useMemo) {
      const key = memoKey(sim);
      const free = sim.machineFree[machines[0]];
      const lst = memoExplore.get(key);
      if (lst && dominated(lst, free, sim.changes)) return;
      if (lst) addPareto(lst, free, sim.changes);
      else memoExplore.set(key, [[free, sim.changes]]);
    }
    const lb = lowerBound(sim, remaining);
    if (bestObj && (lb.makespan > bestObj.makespan || (lb.makespan === bestObj.makespan && lb.changes >= bestObj.changes))) return;
    if (remaining.size === 0) {
      bestObj = { makespan: sim.makespan, changes: sim.changes };
      return;
    }
    const machineOrder = [...machines].sort((x, y) => sim.machineFree[x] - sim.machineFree[y] || (x < y ? -1 : 1));
    for (const oid of edfIds) {
      if (!remaining.has(oid)) continue;
      for (const mm of machineOrder) {
        remaining.delete(oid);
        if (useMemo) remMask &= ~(1 << idxOf.get(oid));
        seqs[mm].push(oid);
        dfs1();
        seqs[mm].pop();
        if (useMemo) remMask |= 1 << idxOf.get(oid);
        remaining.add(oid);
      }
    }
  }
  try {
    dfs1();
  } catch (e) {
    if (e instanceof NodeCap) return greedyFallback(instance, sortedIds);
    throw e;
  }
  if (!bestObj) return { status: "infeasible" };

  // Phase 2: lexicographically smallest canonical plan achieving bestObj.
  const target = bestObj;
  const result = Object.fromEntries(machines.map((mm) => [mm, []]));
  const left = new Set(sortedIds);
  const closed = new Set();

  function exists() {
    function rec() {
      if (++nodes > CAP) throw new NodeCap();
      const sim = simulate(instance, result);
      if (!feasiblePartial(sim)) return false;
      const memoHere = useMemo && closed.size === 0;
      let key = -1;
      let free = 0;
      if (memoHere) {
        key = memoKey(sim);
        free = sim.machineFree[machines[0]];
        const lst = memoFailed.get(key);
        if (lst && dominated(lst, free, sim.changes)) return false;
      }
      const lb = lowerBound(sim, left);
      if (lb.makespan > target.makespan || (lb.makespan === target.makespan && lb.changes > target.changes)) {
        if (memoHere) {
          const lst = memoFailed.get(key);
          if (lst) addPareto(lst, free, sim.changes);
          else memoFailed.set(key, [[free, sim.changes]]);
        }
        return false;
      }
      if (left.size === 0) return sim.makespan <= target.makespan && sim.changes <= target.changes;
      for (const oid of sortedIds) {
        if (!left.has(oid)) continue;
        for (const mm of machines) {
          if (closed.has(mm)) continue;
          left.delete(oid);
          if (useMemo) remMask &= ~(1 << idxOf.get(oid));
          result[mm].push(oid);
          const ok = rec();
          result[mm].pop();
          if (useMemo) remMask |= 1 << idxOf.get(oid);
          left.add(oid);
          if (ok) return true;
        }
      }
      if (memoHere) {
        const lst = memoFailed.get(key);
        if (lst) addPareto(lst, free, sim.changes);
        else memoFailed.set(key, [[free, sim.changes]]);
      }
      return false;
    }
    return rec();
  }

  try {
    for (const mm of machines) {
      for (;;) {
        closed.add(mm);
        if (exists()) break; // machine mm is complete (possibly empty)
        closed.delete(mm);
        let placed = false;
        for (const oid of sortedIds) {
          if (!left.has(oid)) continue;
          left.delete(oid);
          if (useMemo) remMask &= ~(1 << idxOf.get(oid));
          result[mm].push(oid);
          if (exists()) {
            placed = true;
            break;
          }
          result[mm].pop();
          if (useMemo) remMask |= 1 << idxOf.get(oid);
          left.add(oid);
        }
        if (!placed) throw new Error("lexicographic reconstruction failed");
      }
    }
  } catch (e) {
    if (e instanceof NodeCap) return greedyFallback(instance, sortedIds);
    throw e;
  }

  const sim = simulate(instance, result);
  return { status: "optimal", sequences: result, makespan: sim.makespan, changes: sim.changes, plan: sim.plan };
}

export function isFeasible(instance, orderIds) {
  const r = solve(instance, orderIds);
  return r.status !== "infeasible";
}

// Irreducible infeasible subset: removing any order makes it feasible.
export function minimalConflictSet(instance, orderIds) {
  let set = [...orderIds].sort();
  for (const oid of [...set]) {
    if (set.length === 1) break;
    const trial = set.filter((x) => x !== oid);
    if (solve(instance, trial).status === "infeasible") set = trial;
  }
  return set;
}
