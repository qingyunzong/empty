// Finite-domain CSP solver for offline inspection planning.
//
// Variables per task: assigned inspector (finite domain over inspectors whose
// skill set covers the task) and integer start time (finite domain inside the
// task's time window). Propagation prunes domains via skill coverage, time
// windows and a unary-resource (single-machine sequencing) constraint per
// inspector including integer travel times. Backtracking enumerates inspector
// assignments and per-inspector task orderings, minimizing makespan first and
// total travel time on ties.

class BudgetExhausted extends Error {
  constructor(pending) {
    super('branch budget exhausted');
    this.pending = pending;
  }
}

export function solve(input, { budget = 500 } = {}) {
  const tasks = input.tasks;
  const inspectors = input.inspectors;
  const n = tasks.length;
  const zones = tasks.map((t) => t.zone);
  const dur = tasks.map((t) => t.duration);
  const travelMatrix = input.travel ?? {};
  const travel = (a, b) => (a === b ? 0 : (travelMatrix[a]?.[b] ?? 0));

  // Skill propagation: static person domain per task.
  const compat = tasks.map((t) =>
    inspectors
      .map((_, pi) => pi)
      .filter((pi) => t.skills.every((s) => inspectors[pi].skills.includes(s))));

  for (let i = 0; i < n; i++) {
    if (compat[i].length === 0) {
      return {
        status: 'infeasible',
        conflict: {
          type: 'skill',
          tasks: [tasks[i].id],
          requiredSkills: tasks[i].skills,
          missingSkills: tasks[i].skills.filter(
            (s) => !inspectors.some((p) => p.skills.includes(s))),
          persons: inspectors.map((p) => ({ id: p.id, skills: p.skills })),
        },
        stats: { nodes: 0, budget },
      };
    }
  }

  const initState = () => ({
    personDom: compat.map((c) => new Set(c)),
    lo: tasks.map((t) => t.window[0]),
    hi: tasks.map((t) => t.window[1]),
    prec: tasks.map(() => new Set()), // prec[i] has j  <=>  i sequenced before j
  });

  const cloneState = (st) => ({
    personDom: st.personDom.map((s) => new Set(s)),
    lo: [...st.lo],
    hi: [...st.hi],
    prec: st.prec.map((s) => new Set(s)),
  });

  function addPrec(st, i, j) {
    if (st.prec[i].has(j)) return;
    st.prec[i].add(j);
    // transitive closure
    let changed = true;
    while (changed) {
      changed = false;
      const additions = [];
      for (let a = 0; a < n; a++) {
        for (const b of st.prec[a]) {
          for (const c of st.prec[b]) {
            if (!st.prec[a].has(c)) additions.push([a, c]);
          }
        }
      }
      for (const [a, c] of additions) {
        st.prec[a].add(c);
        changed = true;
      }
    }
  }

  const samePerson = (st, i, j) => {
    if (st.personDom[i].size !== 1 || st.personDom[j].size !== 1) return false;
    const [a] = st.personDom[i];
    const [b] = st.personDom[j];
    return a === b;
  };

  // Returns null when consistent, otherwise a conflict proof object.
  function propagate(st) {
    for (let iter = 0; iter < 10000; iter++) {
      let changed = false;

      // Time-window propagation along sequencing edges.
      for (let i = 0; i < n; i++) {
        for (const j of st.prec[i]) {
          const tij = travel(zones[i], zones[j]);
          const nlo = st.lo[i] + dur[i] + tij;
          if (nlo > st.lo[j]) { st.lo[j] = nlo; changed = true; }
          const nhi = st.hi[j] - dur[i] - tij;
          if (nhi < st.hi[i]) { st.hi[i] = nhi; changed = true; }
        }
      }
      for (let i = 0; i < n; i++) {
        if (st.lo[i] > st.hi[i]) {
          return {
            type: 'window',
            tasks: [tasks[i].id],
            window: [st.lo[i], st.hi[i]],
            declaredWindow: tasks[i].window,
          };
        }
      }

      // Unary-resource sequencing between tasks forced onto one inspector.
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (st.prec[i].has(j) || st.prec[j].has(i)) continue;
          if (!samePerson(st, i, j)) continue;
          const ij = st.lo[i] + dur[i] + travel(zones[i], zones[j]) <= st.hi[j];
          const ji = st.lo[j] + dur[j] + travel(zones[j], zones[i]) <= st.hi[i];
          if (!ij && !ji) {
            const [p] = st.personDom[i];
            return {
              type: 'sequence',
              tasks: [tasks[i].id, tasks[j].id],
              person: inspectors[p].id,
              windows: {
                [tasks[i].id]: [st.lo[i], st.hi[i]],
                [tasks[j].id]: [st.lo[j], st.hi[j]],
              },
            };
          }
          if (ij && !ji) { addPrec(st, i, j); changed = true; }
          else if (!ij && ji) { addPrec(st, j, i); changed = true; }
        }
      }

      if (!changed) return null;
    }
    return null;
  }

  function snapshotPending(st) {
    const pending = [];
    for (let i = 0; i < n; i++) {
      if (st.personDom[i].size > 1 || st.lo[i] < st.hi[i]) {
        pending.push({
          task: tasks[i].id,
          personDomain: [...st.personDom[i]].map((pi) => inspectors[pi].id),
          startDomain: [st.lo[i], st.hi[i]],
        });
      }
    }
    return pending;
  }

  function buildSchedule(st) {
    const byPerson = new Map();
    for (let i = 0; i < n; i++) {
      const [p] = st.personDom[i];
      if (!byPerson.has(p)) byPerson.set(p, []);
      byPerson.get(p).push(i);
    }
    const startOf = new Array(n).fill(0);
    let makespan = 0;
    let totalTravel = 0;
    for (const list of byPerson.values()) {
      list.sort((a, b) => (st.prec[a].has(b) ? -1 : st.prec[b].has(a) ? 1 : a - b));
      let prev = -1;
      let prevEnd = 0;
      for (const t of list) {
        let s = st.lo[t];
        if (prev !== -1) {
          const tij = travel(zones[prev], zones[t]);
          s = Math.max(s, prevEnd + tij);
          totalTravel += tij;
        }
        if (s > st.hi[t]) return null;
        startOf[t] = s;
        prevEnd = s + dur[t];
        prev = t;
        if (prevEnd > makespan) makespan = prevEnd;
      }
    }
    const assignments = tasks.map((t, i) => {
      const [p] = st.personDom[i];
      return { task: t.id, person: inspectors[p].id, start: startOf[i] };
    });
    return { makespan, travel: totalTravel, assignments };
  }

  let nodes = 0;
  let best = null;
  let rootConflict = null;

  function search(st, depth) {
    nodes++;
    if (nodes > budget) throw new BudgetExhausted(snapshotPending(st));
    const conflict = propagate(st);
    if (conflict) {
      if (depth === 0) rootConflict = conflict;
      return;
    }
    if (best) {
      let lb = 0;
      for (let i = 0; i < n; i++) lb = Math.max(lb, st.lo[i] + dur[i]);
      if (lb > best.makespan) return;
    }

    // Branch on the person variable with the smallest domain.
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (st.personDom[i].size > 1 &&
          (pick === -1 || st.personDom[i].size < st.personDom[pick].size)) {
        pick = i;
      }
    }
    if (pick !== -1) {
      for (const p of st.personDom[pick]) {
        const child = cloneState(st);
        child.personDom[pick] = new Set([p]);
        search(child, depth + 1);
      }
      return;
    }

    // Branch on an unresolved sequencing pair (enumerate orderings).
    for (let i = 0; i < n; i++) {
      let branched = false;
      for (let j = i + 1; j < n; j++) {
        if (st.prec[i].has(j) || st.prec[j].has(i)) continue;
        if (!samePerson(st, i, j)) continue;
        const c1 = cloneState(st);
        addPrec(c1, i, j);
        search(c1, depth + 1);
        const c2 = cloneState(st);
        addPrec(c2, j, i);
        search(c2, depth + 1);
        branched = true;
        break;
      }
      if (branched) return;
    }

    // Leaf: complete assignment and total order per inspector.
    const sol = buildSchedule(st);
    if (sol && (!best || sol.makespan < best.makespan ||
        (sol.makespan === best.makespan && sol.travel < best.travel))) {
      best = sol;
    }
  }

  let exhaustedPending = null;
  try {
    search(initState(), 0);
  } catch (e) {
    if (e instanceof BudgetExhausted) exhaustedPending = e.pending;
    else throw e;
  }

  if (exhaustedPending) {
    return {
      status: 'unknown',
      pending: exhaustedPending,
      incumbent: best
        ? { makespan: best.makespan, totalTravel: best.travel, assignments: best.assignments }
        : null,
      stats: { nodes, budget },
    };
  }
  if (!best) {
    return {
      status: 'infeasible',
      conflict: rootConflict ?? {
        type: 'exhaustive',
        tasks: tasks.map((t) => t.id),
        persons: inspectors.map((p) => p.id),
        windows: Object.fromEntries(tasks.map((t) => [t.id, t.window])),
        detail: 'exhaustive enumeration of person assignments and task orderings found no feasible plan',
      },
      stats: { nodes, budget },
    };
  }
  return {
    status: 'optimal',
    makespan: best.makespan,
    totalTravel: best.travel,
    assignments: best.assignments,
    stats: { nodes, budget },
  };
}
