'use strict';

// Finite-domain CSP solver for offline inspection planning.
// Variables per task: assigned inspector + integer start time.
// Propagation: skill sets, time windows, disjunctive sequencing per inspector.
// Search: backtracking over (task, person) and (task, start) branches with a
// branch budget; branch-and-bound on (makespan, totalTravel) lexicographic.

function minOf(set) {
  let m = Infinity;
  for (const v of set) if (v < m) m = v;
  return m;
}

function maxOf(set) {
  let m = -Infinity;
  for (const v of set) if (v > m) m = v;
  return m;
}

function solve(model, options = {}) {
  const budget = options.budget === undefined ? 1000 : options.budget;

  const tasks = model.tasks.map((t, index) => ({
    index,
    id: t.id,
    skills: t.skills.slice(),
    duration: t.duration,
    windowStart: t.window.start,
    windowEnd: t.window.end,
    zone: t.zone,
  }));
  const inspectors = model.inspectors.map((p, index) => ({
    index,
    id: p.id,
    skills: new Set(p.skills),
  }));
  const travelTable = model.travel || {};
  function travel(zoneA, zoneB) {
    if (zoneA === zoneB) return 0;
    const ab = travelTable[zoneA] && travelTable[zoneA][zoneB];
    if (ab !== undefined) return ab;
    const ba = travelTable[zoneB] && travelTable[zoneB][zoneA];
    if (ba !== undefined) return ba;
    return 0;
  }

  const n = tasks.length;

  function initialState() {
    return {
      // Skill propagation: person domain = inspectors covering all required skills.
      person: tasks.map((t) =>
        inspectors
          .filter((p) => t.skills.every((s) => p.skills.has(s)))
          .map((p) => p.index)
      ),
      // Time-window propagation: start domain = integer starts fitting the window.
      start: tasks.map((t) => {
        const dom = new Set();
        for (let s = t.windowStart; s + t.duration <= t.windowEnd; s += 1) dom.add(s);
        return dom;
      }),
    };
  }

  function cloneState(state) {
    return {
      person: state.person.map((d) => d.slice()),
      start: state.start.map((d) => new Set(d)),
    };
  }

  // Returns a structured conflict object, or null when no inconsistency is found.
  function propagate(state) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let t = 0; t < n; t += 1) {
        if (state.person[t].length === 0) {
          return {
            type: 'skill',
            task: tasks[t].id,
            skills: tasks[t].skills,
            detail: `no inspector covers the skills required by task ${tasks[t].id}`,
          };
        }
        if (state.start[t].size === 0) {
          return {
            type: 'window',
            task: tasks[t].id,
            window: { start: tasks[t].windowStart, end: tasks[t].windowEnd },
            duration: tasks[t].duration,
            detail: `time window of task ${tasks[t].id} cannot fit its duration`,
          };
        }
      }
      // Disjunctive sequencing: pairs of tasks fixed to the same inspector.
      for (let i = 0; i < n; i += 1) {
        if (state.person[i].length !== 1) continue;
        const p = state.person[i][0];
        for (let j = i + 1; j < n; j += 1) {
          if (state.person[j].length !== 1 || state.person[j][0] !== p) continue;
          const tij = travel(tasks[i].zone, tasks[j].zone);
          const tji = travel(tasks[j].zone, tasks[i].zone);
          const minI = minOf(state.start[i]);
          const maxI = maxOf(state.start[i]);
          const minJ = minOf(state.start[j]);
          const maxJ = maxOf(state.start[j]);
          const canIJ = minI + tasks[i].duration + tij <= maxJ;
          const canJI = minJ + tasks[j].duration + tji <= maxI;
          if (!canIJ && !canJI) {
            return {
              type: 'sequence',
              person: inspectors[p].id,
              tasks: [tasks[i].id, tasks[j].id],
              detail:
                `tasks ${tasks[i].id} and ${tasks[j].id} cannot be sequenced ` +
                `without overlap on inspector ${inspectors[p].id}`,
            };
          }
          if (canIJ && !canJI) {
            // i must precede j.
            const cut = minI + tasks[i].duration + tij;
            for (const s of state.start[j]) {
              if (s < cut) { state.start[j].delete(s); changed = true; }
            }
            const cap = maxJ - tasks[i].duration - tij;
            for (const s of state.start[i]) {
              if (s > cap) { state.start[i].delete(s); changed = true; }
            }
          } else if (!canIJ && canJI) {
            // j must precede i.
            const cut = minJ + tasks[j].duration + tji;
            for (const s of state.start[i]) {
              if (s < cut) { state.start[i].delete(s); changed = true; }
            }
            const cap = maxI - tasks[j].duration - tji;
            for (const s of state.start[j]) {
              if (s > cap) { state.start[j].delete(s); changed = true; }
            }
          }
        }
      }
    }
    return null;
  }

  const state0 = initialState();
  const rootConflict = propagate(state0);
  if (rootConflict) {
    return { status: 'infeasible', conflict: rootConflict, stats: { branches: 0 } };
  }

  let branches = 0;
  let best = null;
  let exhausted = false;
  let pending = null;
  let shallowest = null;

  function makespanLowerBound(state) {
    let lb = 0;
    for (let t = 0; t < n; t += 1) {
      lb = Math.max(lb, minOf(state.start[t]) + tasks[t].duration);
    }
    return lb;
  }

  function solutionFrom(state) {
    const assignments = tasks.map((t, i) => {
      const start = minOf(state.start[i]);
      return {
        task: t.id,
        person: inspectors[state.person[i][0]].id,
        zone: t.zone,
        start,
        end: start + t.duration,
      };
    });
    const makespan = Math.max(...assignments.map((a) => a.end));
    let totalTravel = 0;
    const byPerson = new Map();
    for (const a of assignments) {
      if (!byPerson.has(a.person)) byPerson.set(a.person, []);
      byPerson.get(a.person).push(a);
    }
    for (const list of byPerson.values()) {
      list.sort((a, b) => a.start - b.start);
      for (let k = 1; k < list.length; k += 1) {
        totalTravel += travel(list[k - 1].zone, list[k].zone);
      }
    }
    return { assignments, makespan, totalTravel };
  }

  function isBetter(x, y) {
    return (
      x.makespan < y.makespan ||
      (x.makespan === y.makespan && x.totalTravel < y.totalTravel)
    );
  }

  function pendingOf(state) {
    const out = [];
    for (let t = 0; t < n; t += 1) {
      if (state.person[t].length > 1 || state.start[t].size > 1) out.push(tasks[t].id);
    }
    return out;
  }

  function dfs(state, depth) {
    if (exhausted) return;
    if (best && makespanLowerBound(state) > best.makespan) return;
    // Pick the most constrained undecided variable (MRV): persons first, then starts.
    let ti = -1;
    let kind = null;
    let size = Infinity;
    for (let t = 0; t < n; t += 1) {
      if (state.person[t].length > 1 && state.person[t].length < size) {
        ti = t; kind = 'person'; size = state.person[t].length;
      }
    }
    if (ti === -1) {
      for (let t = 0; t < n; t += 1) {
        if (state.start[t].size > 1 && state.start[t].size < size) {
          ti = t; kind = 'start'; size = state.start[t].size;
        }
      }
    }
    if (ti === -1) {
      const sol = solutionFrom(state);
      if (!best || isBetter(sol, best)) best = sol;
      return;
    }
    const values =
      kind === 'person'
        ? state.person[ti].slice()
        : [...state.start[ti]].sort((a, b) => a - b);
    for (const v of values) {
      if (branches >= budget) {
        exhausted = true;
        if (!pending) pending = pendingOf(state);
        return;
      }
      branches += 1;
      const child = cloneState(state);
      if (kind === 'person') child.person[ti] = [v];
      else child.start[ti] = new Set([v]);
      const conflict = propagate(child);
      if (conflict) {
        if (!shallowest || depth < shallowest.depth) shallowest = { depth, conflict };
        continue;
      }
      dfs(child, depth + 1);
      if (exhausted) return;
    }
  }

  dfs(state0, 0);

  if (exhausted) {
    const result = { status: 'unknown', pending: pending || [], stats: { branches } };
    if (best) result.incumbent = best;
    return result;
  }
  if (best) {
    return { status: 'optimal', ...best, stats: { branches } };
  }
  return {
    status: 'infeasible',
    conflict: shallowest
      ? shallowest.conflict
      : { type: 'search', detail: 'no feasible assignment exists' },
    stats: { branches },
  };
}

module.exports = { solve };
