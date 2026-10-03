'use strict';

// CSP solver for offline parallel-machine scheduling with tooling families.
//
// Variables per job:
//   - machine: finite domain over eligible machine names
//   - start:   integer domain represented as bounds [lo, hi]
// Propagation:
//   - bound propagation from release/deadline windows
//   - non-overlap (disjunctive) propagation between jobs pinned to one machine,
//     accounting for changeover time between different families
// Search: backtracking assignment; every branch consumes one unit of budget.
// Objective: lexicographic (makespan, total changeover time), branch and bound.

function search(instance, budgetLimit) {
  const jobs = instance.jobs;
  const n = jobs.length;
  const machines = instance.machines;
  const setupTime = instance.setupTime;

  const machineDomain = jobs.map((j) => new Set(j.machines));
  const lo = jobs.map((j) => j.release);
  const hi = jobs.map((j) => j.deadline - j.duration);

  let budget = budgetLimit;
  let branchesUsed = 0;
  let best = null;
  let exhausted = false;
  let pending = null;

  const changeover = (i, j) => (jobs[i].family === jobs[j].family ? 0 : setupTime);

  function snapshot() {
    return {
      lo: lo.slice(),
      hi: hi.slice(),
      md: machineDomain.map((s) => new Set(s)),
    };
  }

  function restore(s) {
    for (let i = 0; i < n; i++) {
      lo[i] = s.lo[i];
      hi[i] = s.hi[i];
      machineDomain[i] = s.md[i];
    }
  }

  // Bound propagation + non-overlap propagation to fixpoint.
  // Returns false when a domain wipes out.
  function propagate() {
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < n; j++) {
        if (lo[j] > hi[j]) return false;
      }
      for (const m of machines) {
        const pinned = [];
        for (let j = 0; j < n; j++) {
          if (machineDomain[j].size === 1 && machineDomain[j].has(m)) pinned.push(j);
        }
        for (let a = 0; a < pinned.length; a++) {
          for (let b = a + 1; b < pinned.length; b++) {
            const i = pinned[a];
            const j = pinned[b];
            // i before j is feasible iff some si in dom(i), sj in dom(j)
            // satisfy si + dur_i + changeover(i,j) <= sj.
            const ijPossible = lo[i] + jobs[i].duration + changeover(i, j) <= hi[j];
            const jiPossible = lo[j] + jobs[j].duration + changeover(j, i) <= hi[i];
            if (!ijPossible && !jiPossible) return false;
            if (!ijPossible) {
              // j must precede i
              const newLoI = lo[j] + jobs[j].duration + changeover(j, i);
              if (newLoI > lo[i]) { lo[i] = newLoI; changed = true; }
              const newHiJ = hi[i] - jobs[j].duration - changeover(j, i);
              if (newHiJ < hi[j]) { hi[j] = newHiJ; changed = true; }
            } else if (!jiPossible) {
              // i must precede j
              const newLoJ = lo[i] + jobs[i].duration + changeover(i, j);
              if (newLoJ > lo[j]) { lo[j] = newLoJ; changed = true; }
              const newHiI = hi[j] - jobs[i].duration - changeover(i, j);
              if (newHiI < hi[i]) { hi[i] = newHiI; changed = true; }
            }
          }
        }
      }
    }
    return true;
  }

  function makespanLowerBound() {
    let lb = 0;
    for (let j = 0; j < n; j++) lb = Math.max(lb, lo[j] + jobs[j].duration);
    return lb;
  }

  function better(a, b) {
    return a.makespan < b.makespan || (a.makespan === b.makespan && a.setup < b.setup);
  }

  function evaluate() {
    const assign = machineDomain.map((s) => [...s][0]);
    const starts = lo.slice();
    let makespan = 0;
    let setup = 0;
    for (const m of machines) {
      const seq = [];
      for (let j = 0; j < n; j++) if (assign[j] === m) seq.push(j);
      seq.sort((a, b) => starts[a] - starts[b] || a - b);
      let prev = -1;
      for (const j of seq) {
        if (prev >= 0) setup += changeover(prev, j);
        makespan = Math.max(makespan, starts[j] + jobs[j].duration);
        prev = j;
      }
    }
    return { makespan, setup, starts, assign };
  }

  function currentPending() {
    const list = [];
    for (let j = 0; j < n; j++) {
      if (machineDomain[j].size > 1) {
        list.push({ job: jobs[j].id, variable: 'machine', domain: [...machineDomain[j]] });
      }
      if (hi[j] > lo[j]) {
        list.push({ job: jobs[j].id, variable: 'start', domain: [lo[j], hi[j]] });
      }
    }
    return list;
  }

  function branch(apply) {
    if (budget <= 0) {
      if (!exhausted) {
        exhausted = true;
        pending = currentPending();
      }
      return;
    }
    budget--;
    branchesUsed++;
    const saved = snapshot();
    apply();
    descend();
    restore(saved);
  }

  function descend() {
    if (!propagate()) return;
    if (best) {
      const lb = makespanLowerBound();
      if (lb > best.makespan) return;
      if (lb === best.makespan && best.setup === 0) return;
    }
    // 1) branch on an unassigned machine variable (smallest domain first)
    let mv = -1;
    let mvSize = Infinity;
    for (let j = 0; j < n; j++) {
      const size = machineDomain[j].size;
      if (size > 1 && size < mvSize) { mvSize = size; mv = j; }
    }
    if (mv >= 0) {
      for (const m of [...machineDomain[mv]]) {
        branch(() => { machineDomain[mv] = new Set([m]); });
      }
      return;
    }
    // 2) branch on the widest start domain: start = lo  vs  start >= lo + 1
    let sv = -1;
    let svWidth = 0;
    for (let j = 0; j < n; j++) {
      const w = hi[j] - lo[j];
      if (w > svWidth) { svWidth = w; sv = j; }
    }
    if (sv >= 0) {
      const v = lo[sv];
      branch(() => { hi[sv] = v; });
      branch(() => { lo[sv] = v + 1; });
      return;
    }
    // complete consistent assignment
    const sol = evaluate();
    if (!best || better(sol, best)) best = sol;
  }

  descend();

  return {
    best,
    exhausted,
    pending: exhausted ? pending : null,
    branchesUsed,
  };
}

function buildSchedule(instance, solution) {
  const jobs = instance.jobs;
  const schedule = {};
  for (const m of instance.machines) schedule[m] = [];
  for (let j = 0; j < jobs.length; j++) {
    schedule[solution.assign[j]].push({
      job: jobs[j].id,
      family: jobs[j].family,
      start: solution.starts[j],
      end: solution.starts[j] + jobs[j].duration,
    });
  }
  for (const m of instance.machines) {
    schedule[m].sort((a, b) => a.start - b.start || a.job.localeCompare(b.job));
    for (let k = 0; k < schedule[m].length; k++) {
      schedule[m][k].setupBefore = k > 0 && schedule[m][k - 1].family !== schedule[m][k].family
        ? instance.setupTime
        : 0;
    }
  }
  return schedule;
}

// Deletion-minimal conflict: smallest job subset (by greedy deletion) that is
// still infeasible, together with the machine constraints it involves.
function minimalConflict(instance) {
  let core = instance.jobs.slice();
  for (const job of core.slice()) {
    if (core.length === 1) break;
    const trial = core.filter((j) => j.id !== job.id);
    const r = search({ ...instance, jobs: trial }, Infinity);
    if (!r.best && !r.exhausted) core = trial;
  }
  const machineSet = new Set();
  for (const j of core) for (const m of j.machines) machineSet.add(m);
  return {
    jobs: core.map((j) => ({
      id: j.id,
      release: j.release,
      deadline: j.deadline,
      duration: j.duration,
      machines: j.machines.slice(),
      family: j.family,
    })),
    machineConstraints: [...machineSet].map((m) =>
      `machine ${m}: jobs must not overlap; changeover ${instance.setupTime} between different families`),
  };
}

function solve(instance, options = {}) {
  const budget = options.budget === undefined ? Infinity : options.budget;
  const r = search(instance, budget);
  if (r.best) {
    return {
      status: r.exhausted ? 'feasible' : 'optimal',
      objective: { makespan: r.best.makespan, totalSetup: r.best.setup },
      schedule: buildSchedule(instance, r.best),
      branchesUsed: r.branchesUsed,
    };
  }
  if (r.exhausted) {
    return {
      status: 'unknown',
      reason: 'budget exhausted',
      pendingVariables: r.pending,
      branchesUsed: r.branchesUsed,
    };
  }
  return {
    status: 'unsat',
    conflict: minimalConflict(instance),
    branchesUsed: r.branchesUsed,
  };
}

module.exports = { solve, search, minimalConflict, buildSchedule };
