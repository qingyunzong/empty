'use strict';

// Data model:
//   data.order    : [{ order, process }]                 order demands (process requirements)
//   data.machines : [{ machine, process, cert_expiry }]  capabilities; cert_expiry === null => no valid cert
//   data.costs    : [{ machine, shift_cost }]
//   data.budget   : number (optional; Infinity when absent)
//
// Selection order (deterministic): fewest machines, then lowest total shift_cost,
// then lexicographic by sorted machine-id tuple. A combination is feasible when it
// covers every required process with valid (non-null) certs and costs <= budget.

function requiredProcesses(order) {
  return [...new Set(order.map((row) => row.process))].sort();
}

// Relational-division building block: process -> sorted list of machines holding a
// VALID (non-null) certificate for that process. Null certs never qualify.
function qualifiedByProcess(machines) {
  const map = new Map();
  for (const row of machines) {
    if (row.cert_expiry === null || row.cert_expiry === undefined) continue;
    if (!map.has(row.process)) map.set(row.process, new Set());
    map.get(row.process).add(row.machine);
  }
  const out = new Map();
  for (const [proc, set] of map) out.set(proc, [...set].sort());
  return out;
}

function costTable(costs) {
  const table = new Map();
  for (const row of costs) table.set(row.machine, row.shift_cost);
  return table;
}

function comboCost(machines, costsByMachine) {
  let total = 0;
  for (const m of machines) total += costsByMachine.get(m) ?? 0;
  return total;
}

function covers(combo, procToMachines, processes) {
  const owned = new Set();
  for (const m of combo) {
    for (const [proc, list] of procToMachines) {
      if (list.includes(m)) owned.add(proc);
    }
  }
  return processes.every((p) => owned.has(p));
}

function lexCompare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// Award ordering: machine count asc, total cost asc, machine-id lexicographic.
function compareCombos(a, b) {
  if (a.machines.length !== b.machines.length) return a.machines.length - b.machines.length;
  if (a.cost !== b.cost) return a.cost - b.cost;
  return lexCompare(a.machines, b.machines);
}

// Cost-first ordering, used only to prove budget infeasibility (min-cost cover).
function compareByCost(a, b) {
  if (a.cost !== b.cost) return a.cost - b.cost;
  if (a.machines.length !== b.machines.length) return a.machines.length - b.machines.length;
  return lexCompare(a.machines, b.machines);
}

function makeCombo(machineIds, costsByMachine) {
  const machines = [...machineIds].sort();
  return { machines, cost: comboCost(machines, costsByMachine) };
}

function budgetOf(data) {
  return data.budget === undefined || data.budget === null ? Infinity : data.budget;
}

// Enumerate every feasible combination (covers all required processes and, when
// budget is finite, costs <= budget). Returned sorted by compareCombos.
function candidates(data) {
  const processes = requiredProcesses(data.order || []);
  const procToMachines = qualifiedByProcess(data.machines || []);
  const costsByMachine = costTable(data.costs || []);
  const budget = budgetOf(data);

  const universe = [...new Set(
    processes.flatMap((p) => procToMachines.get(p) || []),
  )].sort();

  const perProcess = processes.map((p) => ({
    process: p,
    machines: procToMachines.get(p) || [],
  }));

  const feasible = [];
  const n = universe.length;
  const chosen = [];
  function dfs(idx, costSoFar) {
    if (costSoFar > budget) return;
    if (idx === n) {
      if (chosen.length > 0 && covers(chosen, procToMachines, processes)) {
        feasible.push(makeCombo(chosen, costsByMachine));
      }
      return;
    }
    const m = universe[idx];
    chosen.push(m);
    dfs(idx + 1, costSoFar + (costsByMachine.get(m) ?? 0));
    chosen.pop();
    dfs(idx + 1, costSoFar);
  }
  dfs(0, 0);
  feasible.sort(compareCombos);
  return { processes, perProcess, feasible };
}

// Minimum-cost combination covering all processes, ignoring budget. This is the
// witness needed to certify budget infeasibility: min_cost > budget.
function cheapestCover(data) {
  const processes = requiredProcesses(data.order || []);
  const procToMachines = qualifiedByProcess(data.machines || []);
  const costsByMachine = costTable(data.costs || []);
  if (processes.some((p) => (procToMachines.get(p) || []).length === 0)) return null;
  const universe = [...new Set(
    processes.flatMap((p) => procToMachines.get(p) || []),
  )].sort();
  let best = null;
  const chosen = [];
  function dfs(idx, costSoFar) {
    if (best && costSoFar >= best.cost) return;
    if (idx === universe.length) {
      if (chosen.length > 0 && covers(chosen, procToMachines, processes)) {
        const combo = makeCombo(chosen, costsByMachine);
        if (!best || compareByCost(combo, best) < 0) best = combo;
      }
      return;
    }
    const m = universe[idx];
    chosen.push(m);
    dfs(idx + 1, costSoFar + (costsByMachine.get(m) ?? 0));
    chosen.pop();
    dfs(idx + 1, costSoFar);
  }
  dfs(0, 0);
  return best;
}

// Minimal infeasibility certificate: either a required process with no qualified
// machine (missing capability), or proof that the min-cost cover exceeds budget.
function infeasibleCertificate(data) {
  const processes = requiredProcesses(data.order || []);
  const procToMachines = qualifiedByProcess(data.machines || []);
  for (const p of processes) {
    if ((procToMachines.get(p) || []).length === 0) {
      return {
        status: 'infeasible',
        reason: 'missing_capability',
        process: p,
        detail: `no machine holds a valid certificate for process ${p}`,
      };
    }
  }
  const best = cheapestCover(data);
  if (!best) {
    return { status: 'infeasible', reason: 'missing_capability', detail: 'no covering combination exists' };
  }
  const budget = budgetOf(data);
  return {
    status: 'infeasible',
    reason: 'budget',
    budget,
    min_cost: best.cost,
    cheapest_combination: best.machines,
    detail: `cheapest feasible combination costs ${best.cost} > budget ${budget}`,
  };
}

function award(data) {
  const { feasible } = candidates(data);
  if (feasible.length === 0) return infeasibleCertificate(data);
  const best = feasible[0];
  return {
    status: 'awarded',
    machines: best.machines,
    cost: best.cost,
    budget: data.budget === undefined || data.budget === null ? null : data.budget,
    certificate: {
      processes: requiredProcesses(data.order || []),
      cost: best.cost,
      ordering: 'machine-count asc, shift_cost asc, machine-id lexicographic',
    },
  };
}

// Incremental change events: revoke_cert / set_budget.
function applyChangeToData(data, change) {
  const next = {
    order: (data.order || []).map((r) => ({ ...r })),
    machines: (data.machines || []).map((r) => ({ ...r })),
    costs: (data.costs || []).map((r) => ({ ...r })),
    budget: data.budget,
  };
  if (change.type === 'revoke_cert') {
    next.machines = next.machines.filter(
      (r) => !(r.machine === change.machine && r.process === change.process),
    );
  } else if (change.type === 'set_budget') {
    next.budget = change.budget;
  } else {
    throw new Error(`unknown change type: ${change.type}`);
  }
  return next;
}

function diffSets(oldMachines, newMachines) {
  const oldSet = new Set(oldMachines || []);
  const newSet = new Set(newMachines || []);
  return {
    removed: [...oldSet].filter((m) => !newSet.has(m)).sort(),
    added: [...newSet].filter((m) => !oldSet.has(m)).sort(),
  };
}

// Apply an incremental event to a stored state { data, award } and return the new
// state plus a transition record (retraction, diff, re-award certificate).
function applyChange(state, change) {
  const oldAward = state.award || null;
  const data = applyChangeToData(state.data, change);
  const newAward = award(data);
  const oldMachines = oldAward && oldAward.status === 'awarded' ? oldAward.machines : [];
  const newMachines = newAward.status === 'awarded' ? newAward.machines : [];
  const transition = {
    change,
    retracted: oldAward,
    diff: diffSets(oldMachines, newMachines),
    award: newAward,
  };
  return { state: { data, award: newAward }, transition };
}

module.exports = {
  requiredProcesses,
  qualifiedByProcess,
  costTable,
  compareCombos,
  compareByCost,
  candidates,
  cheapestCover,
  infeasibleCertificate,
  award,
  applyChangeToData,
  applyChange,
  diffSets,
};
