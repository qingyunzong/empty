// Exact solver: full enumeration of integer start-time assignments.
//
// Feasibility of an assignment:
//   release_i <= s_i
//   s_i + duration_i <= s_j            for every precedence (i, j)
//   for every line l and integer time t:
//     |{ i on l : s_i <= t < s_i + duration_i }| <= capacity_l(t)
//   where capacity_l(t) = sum of window capacities covering t (a line with
//   no windows defaults to 1; covered lines are 0 outside their windows)
//   s_i + duration_i <= due_i          for every task with a finite due
//
// Due dates are hard constraints: a "due conflict" is therefore a genuine
// infeasibility, proven by exhaustive enumeration. Among feasible
// assignments the solver minimizes Lmax = max_i (end_i - due_i).
//
// Objective: minimize Lmax = max_i (s_i + duration_i - due_i),
// ties broken by the lexicographically smallest start-time vector ordered
// by ascending task id.
//
// Two enumeration modes:
//   'active' (default): enumerates all active schedules via serial SGS —
//     branch over every available task, place it at its earliest feasible
//     start. The active schedules are a finite, complete space that provably
//     contains the lexicographically smallest optimum, so optimization and
//     infeasibility proofs remain exact while staying fast for <= 8 tasks.
//   'full': enumerates every feasible start-time assignment (reference
//     algorithm for small horizons).
// Either way enumeration is exhaustive, so infeasibility is proven, never
// inferred from a timeout.

import { INF } from './model.js';

export function capacityAt(state, line, t) {
  const windows = state.capacity.get(line);
  if (!windows || windows.length === 0) return 1;
  let cap = 0;
  for (const w of windows) {
    if (w.start <= t && t < w.end) cap += w.capacity;
  }
  return cap;
}

export function horizonOf(state) {
  let totalDuration = 0;
  let maxRelease = 0;
  let maxWindowEnd = 0;
  for (const task of state.tasks.values()) {
    totalDuration += task.duration;
    if (task.release > maxRelease) maxRelease = task.release;
  }
  for (const windows of state.capacity.values()) {
    for (const w of windows) if (w.end > maxWindowEnd) maxWindowEnd = w.end;
  }
  return maxRelease + Math.max(totalDuration, maxWindowEnd) + 1;
}

function lexCompare(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Enumerate assignments under `tasks`/`precedence`/`capacity`.
// Returns { feasible, count, best: {starts, lmax} | null }.
// `limit` optionally caps the number of complete assignments examined.
export function enumerateAll(state, { limit = Infinity, mode = 'active' } = {}) {
  const ids = [...state.tasks.keys()].sort();
  const n = ids.length;
  const indexOf = new Map(ids.map((id, i) => [id, i]));
  const tasks = ids.map((id) => state.tasks.get(id));
  const horizon = horizonOf(state);

  const lines = [];
  const lineIndex = new Map();
  for (const task of tasks) {
    if (!lineIndex.has(task.line)) {
      lineIndex.set(task.line, lines.length);
      lines.push(task.line);
    }
  }
  const lineOf = tasks.map((t) => lineIndex.get(t.line));
  const capacityGrid = lines.map((line) => {
    const grid = new Array(horizon);
    for (let t = 0; t < horizon; t += 1) grid[t] = capacityAt(state, line, t);
    return grid;
  });

  const preds = tasks.map(() => []);
  const indegree = new Array(n).fill(0);
  for (const [a, b] of state.precedence) {
    const i = indexOf.get(a);
    const j = indexOf.get(b);
    preds[j].push(i);
    indegree[j] += 1;
  }

  const durations = tasks.map((t) => t.duration);
  const releases = tasks.map((t) => t.release);
  const dues = tasks.map((t) => t.due);
  const latestStart = tasks.map((t) => Math.min(horizon, t.due) - t.duration);

  const starts = new Array(n).fill(-1);
  const assigned = new Array(n).fill(false);
  const remaining = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) remaining[i] = indegree[i];

  const usage = lines.map(() => new Array(horizon).fill(0));
  const bestStarts = new Array(n).fill(0);
  let bestLmax = INF;
  let found = false;
  let count = 0;
  let stop = false;

  const fits = (i, s) => {
    const grid = capacityGrid[lineOf[i]];
    const used = usage[lineOf[i]];
    const d = durations[i];
    for (let t = s; t < s + d; t += 1) {
      if (used[t] + 1 > grid[t]) return false;
    }
    return true;
  };

  const dfs = () => {
    if (stop) return;
    // Available tasks: unassigned, all predecessors assigned.
    const available = [];
    for (let i = 0; i < n; i += 1) {
      if (assigned[i] || remaining[i] > 0) continue;
      let est = releases[i];
      for (const p of preds[i]) est = Math.max(est, starts[p] + durations[p]);
      while (est <= latestStart[i] && !fits(i, est)) est += 1;
      if (est > latestStart[i]) return; // task can never be placed: dead end
      available.push([i, est]);
    }
    if (available.length === 0) {
      count += 1;
      let lmax = -INF;
      for (let i = 0; i < n; i += 1) {
        const lateness = starts[i] + durations[i] - dues[i];
        if (lateness > lmax) lmax = lateness;
      }
      if (lmax < bestLmax || (lmax === bestLmax && lexCompare(starts, bestStarts) < 0)) {
        bestLmax = lmax;
        for (let i = 0; i < n; i += 1) bestStarts[i] = starts[i];
      }
      found = true;
      if (count >= limit) stop = true;
      return;
    }
    if (mode === 'active') {
      // Serial SGS: branch over the next task to schedule, placed at its est.
      for (const [i, est] of available) {
        place(i, est);
        if (stop) return;
      }
      return;
    }
    // Full enumeration: branch over every feasible start of the task with
    // the smallest earliest start.
    let chosen = available[0][0];
    let chosenEst = available[0][1];
    for (const [i, est] of available) {
      if (est < chosenEst) {
        chosen = i;
        chosenEst = est;
      }
    }
    for (let s = chosenEst; s <= latestStart[chosen]; s += 1) {
      if (!fits(chosen, s)) continue;
      place(chosen, s);
      if (stop) return;
    }
  };

  const place = (i, s) => {
    const line = lineOf[i];
    starts[i] = s;
    assigned[i] = true;
    for (let t = s; t < s + durations[i]; t += 1) usage[line][t] += 1;
    for (let j = 0; j < n; j += 1) {
      if (!assigned[j]) {
        for (const p of preds[j]) if (p === i) remaining[j] -= 1;
      }
    }
    dfs();
    for (let j = 0; j < n; j += 1) {
      if (!assigned[j]) {
        for (const p of preds[j]) if (p === i) remaining[j] += 1;
      }
    }
    for (let t = s; t < s + durations[i]; t += 1) usage[line][t] -= 1;
    assigned[i] = false;
    starts[i] = -1;
  };

  dfs();
  return { feasible: found, count, best: found ? { starts: [...bestStarts], lmax: bestLmax } : null, ids };
}

// Find a minimum-cardinality infeasible constraint subset by deletion.
// Elements: {type:'task',id} | {type:'precedence',before,after} | {type:'capacity',line,window}
export function findMinInfeasibleSubset(state) {
  const elements = [];
  for (const id of [...state.tasks.keys()].sort()) {
    elements.push({ type: 'task', id });
  }
  state.precedence.forEach(([before, after], i) => {
    elements.push({ type: 'precedence', before, after, index: i });
  });
  for (const [line, windows] of [...state.capacity.entries()].sort()) {
    windows.forEach((w, i) => {
      elements.push({ type: 'capacity', line, window: { ...w }, index: i });
    });
  }

  // Build the sub-problem containing exactly the kept elements; precedence
  // edges whose endpoints are not both kept are meaningless and dropped.
  const isInfeasible = (kept) => {
    const sub = {
      tasks: new Map([...state.tasks].filter(([id]) => kept.some((e) => e.type === 'task' && e.id === id))),
      precedence: [],
      capacity: new Map(),
    };
    state.precedence.forEach(([a, b], i) => {
      if (kept.some((e) => e.type === 'precedence' && e.index === i) && sub.tasks.has(a) && sub.tasks.has(b)) {
        sub.precedence.push([a, b]);
      }
    });
    for (const [line, windows] of state.capacity) {
      sub.capacity.set(line, windows.filter((_, i) => kept.some((e) => e.type === 'capacity' && e.line === line && e.index === i)));
    }
    return !enumerateAll(sub, { limit: 1 }).feasible;
  };

  let remaining = [...elements];
  for (const el of elements) {
    const trial = remaining.filter((e) => e !== el);
    if (isInfeasible(trial)) remaining = trial;
  }
  return remaining.map(({ index, ...rest }) => rest);
}

export function solve(state) {
  const result = enumerateAll(state);
  if (!result.feasible) {
    return {
      status: 'infeasible',
      certificate: {
        method: 'exhaustive-enumeration',
        assignmentsExamined: result.count,
        minInfeasibleSubset: findMinInfeasibleSubset(state),
      },
    };
  }
  const assignments = result.ids.map((id, i) => {
    const task = state.tasks.get(id);
    const start = result.best.starts[i];
    const end = start + task.duration;
    return {
      id,
      line: task.line,
      start,
      end,
      lateness: end - task.due,
    };
  });
  return { status: 'optimal', lmax: result.best.lmax, assignments };
}

export function diffSolutions(prev, next) {
  const key = (a) => `${a.id}@${a.line}[${a.start},${a.end})`;
  const before = new Map((prev?.assignments ?? []).map((a) => [a.id, a]));
  const after = new Map((next?.assignments ?? []).map((a) => [a.id, a]));
  const changed = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b || b.start !== a.start || b.end !== a.end || b.line !== a.line) changed.push(id);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) changed.push(id);
  }
  return changed.sort();
}
