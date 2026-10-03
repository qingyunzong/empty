// Exact solver: lexicographic cost [shiftsUsed, setupTime], fixed tie-break.
//
// Candidate order for every job is sorted by (shiftIdx, moldIdx); DFS explores
// candidates in that order and keeps the FIRST plan achieving the best cost,
// which is exactly the lexicographically smallest assignment vector over jobs
// sorted by id. Parallel-optimal instances therefore always yield one plan.

export function solve(jobs, molds, shifts) {
  const jobList = [...jobs].sort((a, b) => (a.id < b.id ? -1 : 1));
  const moldIdx = new Map(molds.map((m, i) => [m.id, i]));
  const moldById = new Map(molds.map((m) => [m.id, m]));
  const n = jobList.length;

  const candidates = jobList.map((j) => {
    const list = [];
    for (let s = 0; s < shifts.length; s++) {
      for (const m of [...j.eligible].sort((a, b) => moldIdx.get(a) - moldIdx.get(b))) {
        list.push({ shift: s, mold: m });
      }
    }
    return list;
  });

  const load = shifts.map(() => 0);
  const usage = molds.map(() => 0);
  const shiftMolds = shifts.map(() => new Set());
  const assign = new Array(n).fill(null);

  let best = null; // { cost: [shiftsUsed, setupTime], assign: [...] }

  function better(costA, costB) {
    return costA[0] < costB[0] || (costA[0] === costB[0] && costA[1] < costB[1]);
  }

  function dfs(i, shiftsUsed, setupTime) {
    if (best) {
      // partial costs only grow; prune if already lexicographically worse
      const worse =
        shiftsUsed > best.cost[0] ||
        (shiftsUsed === best.cost[0] && setupTime > best.cost[1]);
      if (worse) return;
    }
    if (i === n) {
      const cost = [shiftsUsed, setupTime];
      if (!best || better(cost, best.cost)) {
        best = { cost, assign: assign.map((a, k) => ({ job: jobList[k].id, ...a })) };
      }
      return;
    }
    const job = jobList[i];
    for (const cand of candidates[i]) {
      const mi = moldIdx.get(cand.mold);
      const mold = moldById.get(cand.mold);
      if (load[cand.shift] + job.units > shifts[cand.shift].budget) continue;
      if (usage[mi] + job.units > mold.life) continue;
      const newShift = shiftMolds[cand.shift].size === 0 &&
        !assign.slice(0, i).some((a) => a && a.shift === cand.shift);
      const newSetup = shiftMolds[cand.shift].has(cand.mold) ? 0 : mold.changeTime;
      load[cand.shift] += job.units;
      usage[mi] += job.units;
      shiftMolds[cand.shift].add(cand.mold);
      assign[i] = cand;
      dfs(i + 1, shiftsUsed + (newShift ? 1 : 0), setupTime + newSetup);
      assign[i] = null;
      shiftMolds[cand.shift] = recomputeShiftMolds(assign, i, cand.shift);
      usage[mi] -= job.units;
      load[cand.shift] -= job.units;
    }
  }

  function recomputeShiftMolds(assignArr, upto, shift) {
    const set = new Set();
    for (let k = 0; k < upto; k++) {
      if (assignArr[k] && assignArr[k].shift === shift) set.add(assignArr[k].mold);
    }
    return set;
  }

  dfs(0, 0, 0);
  return best; // null => no feasible plan exists for these inputs
}

// Brute-force enumerator for cross-checking (used by tests, n <= 9).
export function enumerateAll(jobs, molds, shifts) {
  const jobList = [...jobs].sort((a, b) => (a.id < b.id ? -1 : 1));
  const results = [];
  const assign = new Array(jobList.length).fill(null);
  function costOf() {
    const usedShifts = new Set();
    const perShiftMolds = new Map();
    for (const a of assign) {
      usedShifts.add(a.shift);
      if (!perShiftMolds.has(a.shift)) perShiftMolds.set(a.shift, new Set());
      perShiftMolds.get(a.shift).add(a.mold);
    }
    let setup = 0;
    for (const set of perShiftMolds.values()) {
      for (const m of set) setup += molds.find((x) => x.id === m).changeTime;
    }
    return [usedShifts.size, setup];
  }
  function rec(i) {
    if (i === jobList.length) {
      results.push({ cost: costOf(), assign: assign.map((a, k) => ({ job: jobList[k].id, ...a })) });
      return;
    }
    const job = jobList[i];
    for (let s = 0; s < shifts.length; s++) {
      for (const m of job.eligible) {
        assign[i] = { shift: s, mold: m };
        // constraint check
        const load = shifts.map(() => 0);
        const usage = new Map(molds.map((x) => [x.id, 0]));
        let ok = true;
        for (let k = 0; k <= i; k++) {
          load[assign[k].shift] += jobList[k].units;
          usage.set(assign[k].mold, usage.get(assign[k].mold) + jobList[k].units);
          if (load[assign[k].shift] > shifts[assign[k].shift].budget) ok = false;
          if (usage.get(assign[k].mold) > molds.find((x) => x.id === assign[k].mold).life) ok = false;
        }
        if (ok) rec(i + 1);
      }
    }
  }
  rec(0);
  return results;
}
