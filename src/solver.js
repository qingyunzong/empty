// Exact deterministic optimizer.
//
// Objective (lexicographic, in this order):
//   1. minimize total downtime = sum of task completion times (each asset is
//      down until its repair finishes; predecessor downtime propagates to
//      successors through precedence constraints),
//   2. minimize total cost,
//   3. minimize the task sequence lexicographically, where the sequence lists
//      task ids ordered by (start, crew, id).
//
// Method: branch & bound over mode assignments (pruned by budget/parts lower
// bounds) x topological orders (pruned by a downtime lower bound). Schedules
// are built by a canonical serial scheme: tasks in priority order are placed
// at the earliest feasible time on the crew where they complete earliest
// (ties -> lowest crew index). This generates all active schedules, which
// contain an optimum for any regular objective. All iteration orders are
// sorted, so ties are reproduced objectively regardless of Map/insertion
// order.

function lexCompareSeq(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export function compareTuples(a, b) {
  // a/b: { downtime, cost, sequence }
  if (a.downtime !== b.downtime) return a.downtime - b.downtime;
  if (a.cost !== b.cost) return a.cost - b.cost;
  return lexCompareSeq(a.sequence, b.sequence);
}

// Canonical serial schedule generation for one priority order (permutation of
// task indices that respects precedence) with fixed mode durations.
export function canonicalSchedule(perm, durations, preds, crews) {
  const n = durations.length;
  const avail = new Array(crews).fill(0);
  const start = new Array(n).fill(0);
  const end = new Array(n).fill(0);
  const crew = new Array(n).fill(0);
  for (const j of perm) {
    let est = 0;
    for (const p of preds[j]) if (end[p] > est) est = end[p];
    let bestCrew = 0;
    let bestEnd = Infinity;
    for (let k = 0; k < crews; k++) {
      const e = Math.max(avail[k], est) + durations[j];
      if (e < bestEnd) {
        bestEnd = e;
        bestCrew = k;
      }
    }
    const s = Math.max(avail[bestCrew], est);
    start[j] = s;
    end[j] = s + durations[j];
    crew[j] = bestCrew;
    avail[bestCrew] = end[j];
  }
  return { start, end, crew };
}

export function sequenceOf(order, start, crew, ids) {
  const sorted = [...order].sort((a, b) => {
    if (start[a] !== start[b]) return start[a] - start[b];
    if (crew[a] !== crew[b]) return crew[a] - crew[b];
    return ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0;
  });
  return sorted.map((j) => ids[j]);
}

export function solve(state) {
  const tasks = state.tasks;
  const n = tasks.length;
  const crews = state.crews;
  const ids = tasks.map((t) => t.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const preds = tasks.map((t) => t.deps.map((d) => index.get(d)));
  const succs = tasks.map(() => []);
  preds.forEach((ps, j) => ps.forEach((p) => succs[p].push(j)));
  const partIds = Object.keys(state.parts);

  const certificate = {
    method: 'exact-branch-and-bound',
    deterministic: true,
    objectiveOrder: ['totalDowntime', 'totalCost', 'taskSequence'],
    crews,
    taskCount: n,
    modeAssignments: { explored: 0, feasible: 0, pruned: 0 },
    schedules: { evaluated: 0, nodesPruned: 0 },
  };

  if (n === 0) {
    return {
      status: 'optimal',
      downtime: 0,
      cost: 0,
      sequence: [],
      modes: {},
      intervals: [],
      crews: Array.from({ length: crews }, () => []),
      partsUsed: {},
      certificate: {
        ...certificate,
        optimum: { downtime: 0, cost: 0, sequence: [] },
        proof: 'Empty task set: the empty schedule is trivially optimal.',
      },
    };
  }

  // Suffix minima for safe pruning of mode assignments.
  const minCost = tasks.map((t) => Math.min(...t.modes.map((m) => m.cost)));
  const minPart = {};
  for (const p of partIds) {
    minPart[p] = tasks.map((t) => Math.min(...t.modes.map((m) => m.parts[p] || 0)));
  }
  const suffixMinCost = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffixMinCost[i] = suffixMinCost[i + 1] + minCost[i];
  const suffixMinPart = {};
  for (const p of partIds) {
    const arr = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) arr[i] = arr[i + 1] + minPart[p][i];
    suffixMinPart[p] = arr;
  }

  // Feasibility diagnosis (independent of enumeration).
  const violations = [];
  const minTotalCost = suffixMinCost[0];
  if (minTotalCost > state.budget) {
    violations.push({
      code: 'BUDGET_EXCEEDED',
      message: `minimum attainable cost ${minTotalCost} exceeds budget ${state.budget}`,
      minCost: minTotalCost,
      budget: state.budget,
    });
  }
  for (const p of partIds) {
    if (suffixMinPart[p][0] > state.parts[p]) {
      violations.push({
        code: 'PART_SHORTAGE',
        message: `minimum required quantity ${suffixMinPart[p][0]} of part "${p}" exceeds available ${state.parts[p]}`,
        part: p,
        minRequired: suffixMinPart[p][0],
        available: state.parts[p],
      });
    }
  }

  let best = null; // { downtime, cost, sequence, modes: Int[], sched }

  // --- scheduling for a fixed mode assignment: B&B over topological orders ---
  const indeg = preds.map((ps) => ps.length);
  function solveDurations(durations, cost) {
    const avail = new Array(crews).fill(0);
    const end = new Array(n).fill(0);
    const start = new Array(n).fill(0);
    const crewOf = new Array(n).fill(0);
    const deg = [...indeg];
    const scheduled = new Array(n).fill(false);
    let sumC = 0;
    // Seeding with the global best downtime is safe: branches that cannot
    // tie or beat it cannot improve the global (downtime, cost, seq) tuple.
    let bestSum = best ? best.downtime : Infinity;
    let bestLocal = null;

    // Lower bound on the total completion time of unscheduled tasks.
    // (a) precedence bound: ignore crew capacity, respect precedence chains
    //     from the current partial schedule;
    // (b) capacity bound: ignore precedence, relax all crew availabilities to
    //     the minimum, then the optimal sum of completion times on identical
    //     crews is given by the SPT rule in closed form.
    // Both are valid relaxations, so their maximum is a valid bound.
    function lowerBound() {
      const ec = new Array(n).fill(0);
      for (let j = 0; j < n; j++) if (scheduled[j]) ec[j] = end[j];
      let lbPrec = sumC;
      const resolved = scheduled.slice();
      let remaining = n - scheduled.reduce((a, b) => a + (b ? 1 : 0), 0);
      let minAvail = Infinity;
      for (let k = 0; k < crews; k++) if (avail[k] < minAvail) minAvail = avail[k];
      const restDurations = [];
      while (remaining > 0) {
        for (let j = 0; j < n; j++) {
          if (resolved[j]) continue;
          let ready = true;
          let est = minAvail;
          for (const p of preds[j]) {
            if (!resolved[p]) { ready = false; break; }
            if (ec[p] > est) est = ec[p];
          }
          if (!ready) continue;
          ec[j] = est + durations[j];
          lbPrec += ec[j];
          restDurations.push(durations[j]);
          resolved[j] = true;
          remaining--;
        }
      }
      restDurations.sort((a, b) => a - b);
      let sptSum = 0;
      const k = restDurations.length;
      for (let i = 0; i < k; i++) {
        sptSum += restDurations[i] * Math.ceil((k - i) / crews);
      }
      const lbCap = sumC + k * minAvail + sptSum;
      return Math.max(lbPrec, lbCap);
    }

    function recurse(count) {
      if (count === n) {
        certificate.schedules.evaluated++;
        const order = [];
        for (let j = 0; j < n; j++) order.push(j);
        const sequence = sequenceOf(order, start, crewOf, ids);
        const cand = { downtime: sumC, cost, sequence };
        if (sumC < bestSum) bestSum = sumC;
        if (!bestLocal || compareTuples(cand, bestLocal) < 0) {
          bestLocal = {
            ...cand,
            start: [...start],
            end: [...end],
            crew: [...crewOf],
          };
        }
        return;
      }
      // Safe prune: no leaf below can achieve downtime <= bound, so the local
      // optimum cannot improve. Ties (bound == bestSum) are still explored to
      // keep the cost/sequence tie-breaking exact.
      if (lowerBound() > bestSum) {
        certificate.schedules.nodesPruned++;
        return;
      }
      const ready = [];
      for (let j = 0; j < n; j++) {
        if (!scheduled[j] && deg[j] === 0) ready.push(j);
      }
      // Deterministic SPT-ish order: good incumbents early. Result is
      // order-independent because tie branches are never pruned.
      ready.sort((a, b) => (durations[a] !== durations[b] ? durations[a] - durations[b] : a - b));
      for (const j of ready) {
        // place j canonically
        let est = 0;
        for (const p of preds[j]) if (end[p] > est) est = end[p];
        let bestCrew = 0;
        let bestEnd = Infinity;
        for (let k = 0; k < crews; k++) {
          const e = Math.max(avail[k], est) + durations[j];
          if (e < bestEnd) { bestEnd = e; bestCrew = k; }
        }
        const s = Math.max(avail[bestCrew], est);
        scheduled[j] = true;
        start[j] = s;
        end[j] = s + durations[j];
        crewOf[j] = bestCrew;
        const savedAvail = avail[bestCrew];
        avail[bestCrew] = end[j];
        sumC += end[j];
        for (const sc of succs[j]) deg[sc]--;
        recurse(count + 1);
        for (const sc of succs[j]) deg[sc]++;
        sumC -= end[j];
        avail[bestCrew] = savedAvail;
        scheduled[j] = false;
      }
    }
    recurse(0);
    return bestLocal;
  }

  // --- branch & bound over mode assignments (tasks in sorted id order) ---
  const chosen = new Array(n).fill(0);
  const partsSoFar = {};
  for (const p of partIds) partsSoFar[p] = 0;

  function assignModes(i, costSoFar) {
    if (costSoFar + suffixMinCost[i] > state.budget) {
      certificate.modeAssignments.pruned++;
      return;
    }
    for (const p of partIds) {
      if (partsSoFar[p] + suffixMinPart[p][i] > state.parts[p]) {
        certificate.modeAssignments.pruned++;
        return;
      }
    }
    if (i === n) {
      certificate.modeAssignments.feasible++;
      const durations = chosen.map((mi, j) => tasks[j].modes[mi].duration);
      const local = solveDurations(durations, costSoFar);
      if (local) {
        const cand = { downtime: local.downtime, cost: local.cost, sequence: local.sequence };
        if (!best || compareTuples(cand, best) < 0) {
          best = {
            ...cand,
            modes: [...chosen],
            start: local.start,
            end: local.end,
            crew: local.crew,
          };
        }
      }
      return;
    }
    certificate.modeAssignments.explored++;
    const modes = tasks[i].modes;
    for (let mi = 0; mi < modes.length; mi++) {
      const m = modes[mi];
      chosen[i] = mi;
      let ok = true;
      for (const p of partIds) {
        partsSoFar[p] += m.parts[p] || 0;
        if (partsSoFar[p] + suffixMinPart[p][i + 1] > state.parts[p]) ok = false;
      }
      if (ok) assignModes(i + 1, costSoFar + m.cost);
      else certificate.modeAssignments.pruned++;
      for (const p of partIds) partsSoFar[p] -= m.parts[p] || 0;
    }
  }
  assignModes(0, 0);

  if (!best) {
    return {
      status: 'infeasible',
      violations,
      certificate: {
        ...certificate,
        optimum: null,
        proof: violations.length > 0
          ? `Infeasible: ${violations.map((v) => v.message).join('; ')}.`
          : 'Infeasible: no mode assignment satisfies the budget and spare-parts constraints.',
      },
    };
  }

  const modeOf = {};
  const perTask = {};
  const crewLists = Array.from({ length: crews }, () => []);
  const partsUsed = {};
  for (const p of partIds) partsUsed[p] = 0;
  for (let j = 0; j < n; j++) {
    const mi = best.modes[j];
    const mode = tasks[j].modes[mi];
    modeOf[ids[j]] = mi;
    for (const p of partIds) partsUsed[p] += mode.parts[p] || 0;
    const entry = {
      task: ids[j],
      crew: best.crew[j],
      start: best.start[j],
      end: best.end[j],
      mode: mi,
      duration: mode.duration,
      cost: mode.cost,
    };
    perTask[ids[j]] = entry;
    crewLists[best.crew[j]].push(entry);
  }
  for (const list of crewLists) {
    list.sort((a, b) => (a.start !== b.start ? a.start - b.start : a.task < b.task ? -1 : 1));
  }
  const intervals = [...Array(n).keys()]
    .map((j) => perTask[ids[j]])
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : a.crew !== b.crew ? a.crew - b.crew : a.task < b.task ? -1 : 1));

  return {
    status: 'optimal',
    downtime: best.downtime,
    cost: best.cost,
    sequence: best.sequence,
    modes: modeOf,
    perTask,
    intervals,
    crews: crewLists,
    partsUsed,
    certificate: {
      ...certificate,
      optimum: { downtime: best.downtime, cost: best.cost, sequence: best.sequence },
      proof:
        'All mode assignments and all active schedules were enumerated with safe ' +
        'lower-bound pruning (budget/parts suffix minima; precedence-respecting ' +
        'downtime bound). No feasible schedule with a lexicographically smaller ' +
        '(downtime, cost, taskSequence) objective exists.',
    },
  };
}
