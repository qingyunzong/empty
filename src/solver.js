'use strict';

const { normalize } = require('./model');

const INF = Number.MAX_SAFE_INTEGER;

class BudgetExhausted extends Error {
  constructor(snapshot) {
    super('branch budget exhausted');
    this.name = 'BudgetExhausted';
    this.snapshot = snapshot;
  }
}

// Internal instance: jobs carry machine indices instead of ids.
function buildInstance(model) {
  const machineIndex = new Map(model.machineIds.map((id, i) => [id, i]));
  return {
    machineIds: model.machineIds.slice(),
    setupTime: model.setupTime,
    jobs: model.jobs.map((j) => ({
      id: j.id,
      release: j.release,
      duration: j.duration,
      deadline: j.deadline,
      family: j.family,
      machines: j.machines.slice(),
      machineIdxs: j.machines.map((id) => machineIndex.get(id)),
    })),
  };
}

// Finite-domain state per job: machine domain (Set of machine indices)
// and integer start-time domain [lo, hi].
function initialState(inst, makespanBound) {
  return inst.jobs.map((j) => ({
    machines: new Set(j.machineIdxs),
    lo: j.release,
    hi: Math.min(j.deadline - j.duration, makespanBound - j.duration),
  }));
}

function cloneState(st) {
  return st.map((d) => ({ machines: new Set(d.machines), lo: d.lo, hi: d.hi }));
}

function setupBetween(inst, a, b) {
  return inst.jobs[a].family === inst.jobs[b].family ? 0 : inst.setupTime;
}

// Bound propagation + non-overlap (disjunctive) propagation to fixpoint.
// Mutates st in place. Returns false on a proven conflict.
function propagate(inst, st, opts) {
  const n = inst.jobs.length;
  for (let i = 0; i < n; i++) {
    const j = inst.jobs[i];
    if (st[i].machines.size === 0) return false;
    if (st[i].lo < j.release) st[i].lo = j.release;
    const hiMax = Math.min(j.deadline - j.duration, opts.makespanBound - j.duration);
    if (st[i].hi > hiMax) st[i].hi = hiMax;
    if (st[i].lo > st[i].hi) return false;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (st[i].machines.size !== 1) continue;
      const m = st[i].machines.values().next().value;
      for (let k = i + 1; k < n; k++) {
        if (st[k].machines.size !== 1 || !st[k].machines.has(m)) continue;
        const di = inst.jobs[i].duration;
        const dk = inst.jobs[k].duration;
        const s = setupBetween(inst, i, k);
        // i can precede k iff some start of i leaves room before some start of k.
        const iBeforeK = st[i].lo + di + s <= st[k].hi;
        const kBeforeI = st[k].lo + dk + s <= st[i].hi;
        if (!iBeforeK && !kBeforeI) return false;
        if (!kBeforeI) {
          const lo = st[i].lo + di + s;
          if (st[k].lo < lo) { st[k].lo = lo; changed = true; }
          const hi = st[k].hi - di - s;
          if (st[i].hi > hi) { st[i].hi = hi; changed = true; }
        } else if (!iBeforeK) {
          const lo = st[k].lo + dk + s;
          if (st[i].lo < lo) { st[i].lo = lo; changed = true; }
          const hi = st[i].hi - dk - s;
          if (st[k].hi > hi) { st[k].hi = hi; changed = true; }
        }
        if (st[i].lo > st[i].hi || st[k].lo > st[k].hi) return false;
      }
    }
  }

  // Lower bound on total setup: a machine holding jobs of k distinct
  // families needs at least (k - 1) family changes.
  if (opts.setupBound < INF) {
    const famsPerMachine = new Map();
    for (let i = 0; i < n; i++) {
      if (st[i].machines.size !== 1) continue;
      const m = st[i].machines.values().next().value;
      if (!famsPerMachine.has(m)) famsPerMachine.set(m, new Set());
      famsPerMachine.get(m).add(inst.jobs[i].family);
    }
    let lb = 0;
    for (const fams of famsPerMachine.values()) lb += (fams.size - 1) * inst.setupTime;
    if (lb > opts.setupBound) return false;
  }

  return true;
}

function pickBranchVar(inst, st) {
  let best = -1;
  let bestSize = Infinity;
  for (let i = 0; i < st.length; i++) {
    const size = st[i].machines.size;
    if (size > 1 && size < bestSize) {
      best = i;
      bestSize = size;
    }
  }
  if (best >= 0) return { idx: best, kind: 'machine' };
  best = -1;
  let bestRange = 0;
  for (let i = 0; i < st.length; i++) {
    const range = st[i].hi - st[i].lo;
    if (range > bestRange) {
      best = i;
      bestRange = range;
    }
  }
  if (best >= 0) return { idx: best, kind: 'start' };
  return null;
}

// Build a per-machine verifiable schedule from a fully decided state.
function extractSolution(inst, st) {
  const perMachine = inst.machineIds.map(() => []);
  for (let i = 0; i < inst.jobs.length; i++) {
    const m = st[i].machines.values().next().value;
    perMachine[m].push(i);
  }
  let makespan = 0;
  let totalSetup = 0;
  const schedule = inst.machineIds.map((id, m) => {
    const seq = perMachine[m]
      .map((i) => ({ i, start: st[i].lo }))
      .sort((a, b) => a.start - b.start || a.i - b.i);
    const entries = seq.map(({ i, start }) => {
      const j = inst.jobs[i];
      return { job: j.id, family: j.family, start, end: start + j.duration };
    });
    for (let k = 0; k < entries.length; k++) {
      if (entries[k].end > makespan) makespan = entries[k].end;
      if (k > 0) {
        const s = setupBetween(inst, seq[k - 1].i, seq[k].i);
        totalSetup += s;
        if (entries[k].start < entries[k - 1].end + s) {
          throw new Error('internal error: overlapping jobs in leaf state');
        }
      }
    }
    return { machine: id, jobs: entries };
  });
  return { makespan, totalSetup, schedule };
}

// Depth-first backtracking search. Budget is consumed per branch point.
// Returns a solution object, null if proven infeasible, or throws
// BudgetExhausted carrying a snapshot of the undecided domains.
function dfs(inst, st, opts, budget) {
  if (!propagate(inst, st, opts)) return null;
  const branch = pickBranchVar(inst, st);
  if (!branch) return extractSolution(inst, st);
  if (budget.left <= 0) throw new BudgetExhausted(cloneState(st));
  budget.left -= 1;
  if (branch.kind === 'machine') {
    for (const m of st[branch.idx].machines) {
      const child = cloneState(st);
      child[branch.idx].machines = new Set([m]);
      const r = dfs(inst, child, opts, budget);
      if (r) return r;
    }
    return null;
  }
  const mid = (st[branch.idx].lo + st[branch.idx].hi) >> 1;
  const low = cloneState(st);
  low[branch.idx].hi = mid;
  const r1 = dfs(inst, low, opts, budget);
  if (r1) return r1;
  const high = cloneState(st);
  high[branch.idx].lo = mid + 1;
  return dfs(inst, high, opts, budget);
}

function search(inst, opts, budget) {
  return dfs(inst, initialState(inst, opts.makespanBound), opts, budget);
}

function pendingVariables(inst, st) {
  const out = [];
  for (let i = 0; i < inst.jobs.length; i++) {
    if (st[i].machines.size > 1 || st[i].hi > st[i].lo) {
      out.push({
        job: inst.jobs[i].id,
        machineDomain: [...st[i].machines].map((m) => inst.machineIds[m]),
        startDomain: [st[i].lo, st[i].hi],
      });
    }
  }
  return out;
}

function unknownResult(inst, snapshot, budget, budgetLimit, incumbent) {
  const result = {
    status: 'unknown',
    reason: 'branch budget exhausted',
    branchesUsed: budgetLimit - budget.left,
    pendingVariables: pendingVariables(inst, snapshot),
  };
  if (incumbent) {
    result.incumbent = {
      makespan: incumbent.makespan,
      totalSetup: incumbent.totalSetup,
      schedule: incumbent.schedule,
    };
  }
  return result;
}

// Lexicographic optimization of (makespan, totalSetup) via iterative
// tightening: first minimize makespan, then total setup under the
// optimal makespan bound. All sub-searches share one branch budget.
function optimize(inst, budgetLimit) {
  const budget = { left: budgetLimit };
  let best;
  try {
    best = search(inst, { makespanBound: INF, setupBound: INF }, budget);
  } catch (e) {
    if (e instanceof BudgetExhausted) return unknownResult(inst, e.snapshot, budget, budgetLimit, null);
    throw e;
  }
  if (!best) return { status: 'infeasible', branchesUsed: budgetLimit - budget.left };

  for (;;) {
    let s;
    try {
      s = search(inst, { makespanBound: best.makespan - 1, setupBound: INF }, budget);
    } catch (e) {
      if (e instanceof BudgetExhausted) return unknownResult(inst, e.snapshot, budget, budgetLimit, best);
      throw e;
    }
    if (!s) break;
    best = s;
  }
  for (;;) {
    let s;
    try {
      s = search(inst, { makespanBound: best.makespan, setupBound: best.totalSetup - 1 }, budget);
    } catch (e) {
      if (e instanceof BudgetExhausted) return unknownResult(inst, e.snapshot, budget, budgetLimit, best);
      throw e;
    }
    if (!s) break;
    best = s;
  }
  return {
    status: 'optimal',
    makespan: best.makespan,
    totalSetup: best.totalSetup,
    schedule: best.schedule,
    branchesUsed: budgetLimit - budget.left,
  };
}

function checkFeasible(inst, budgetLimit) {
  const budget = { left: budgetLimit };
  try {
    return search(inst, { makespanBound: INF, setupBound: INF }, budget) ? 'feasible' : 'infeasible';
  } catch (e) {
    if (e instanceof BudgetExhausted) return 'unknown';
    throw e;
  }
}

// Deletion-based minimal conflict: a job is dropped from the core only if
// the remaining jobs are still proven infeasible.
function extractConflictCore(inst, budgetLimit) {
  let core = inst.jobs.map((_, i) => i);
  let i = 0;
  while (i < core.length) {
    if (core.length === 1) break;
    const trial = core.filter((_, k) => k !== i);
    const sub = {
      machineIds: inst.machineIds,
      setupTime: inst.setupTime,
      jobs: trial.map((x) => inst.jobs[x]),
    };
    if (checkFeasible(sub, budgetLimit) === 'infeasible') {
      core = trial;
    } else {
      i += 1;
    }
  }
  return core;
}

function conflictReport(inst, coreIdxs) {
  const jobs = coreIdxs.map((i) => {
    const j = inst.jobs[i];
    return {
      id: j.id,
      release: j.release,
      deadline: j.deadline,
      duration: j.duration,
      machines: j.machines.slice(),
      family: j.family,
    };
  });
  const usedMachines = [...new Set(coreIdxs.flatMap((i) => inst.jobs[i].machines))];
  const machineConstraints = usedMachines.map((id) => ({
    machine: id,
    constraint: 'no-overlap',
    setupTime: inst.setupTime,
    detail: `jobs assigned to ${id} must not overlap; a setup of ${inst.setupTime} is required between adjacent jobs of different families`,
  }));
  const constraints = [
    ...jobs.map(
      (j) =>
        `job ${j.id}: release=${j.release} deadline=${j.deadline} duration=${j.duration} machines=[${j.machines.join(',')}] family=${j.family}`
    ),
    ...usedMachines.map(
      (id) => `machine ${id}: non-overlap with setupTime=${inst.setupTime} between different families`
    ),
  ];
  return { jobs, machineConstraints, constraints };
}

// Top-level entry: normalize -> solve -> (on infeasible) extract a minimal
// conflict constraint set.
function solve(model, options = {}) {
  const budget = options.budget === undefined ? 10000 : options.budget;
  const conflictBudget = options.conflictBudget === undefined ? 100000 : options.conflictBudget;
  const inst = buildInstance(model);
  const result = optimize(inst, budget);
  if (result.status !== 'infeasible') return result;
  const core = extractConflictCore(inst, conflictBudget);
  return {
    status: 'infeasible',
    branchesUsed: result.branchesUsed,
    conflict: conflictReport(inst, core),
  };
}

module.exports = {
  INF,
  BudgetExhausted,
  buildInstance,
  initialState,
  propagate,
  search,
  optimize,
  extractConflictCore,
  solve,
  normalize,
};
