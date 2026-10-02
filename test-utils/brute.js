// Independent brute-force reference implementations used by the acceptance
// tests. They share no code with src/solver.js.
//
// bruteForceReference: enumerate ALL mode combinations x ALL legal
//   topological orders; for each order build the canonical serial schedule
//   (earliest feasible start, earliest-completing crew, ties -> lowest crew).
//
// bruteForceWithCrews: additionally enumerate ALL crew assignments per order,
//   simulate placement on the assigned crew, then re-canonicalize by
//   re-scheduling in (start, id) order. Explores a different (larger) raw
//   space; used to cross-check the canonical-crew semantics.

function lexCmp(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function better(a, b) {
  if (a.downtime !== b.downtime) return a.downtime < b.downtime;
  if (a.cost !== b.cost) return a.cost < b.cost;
  return lexCmp(a.sequence, b.sequence) < 0;
}

function serialSchedule(order, durations, preds, crews) {
  const n = durations.length;
  const avail = new Array(crews).fill(0);
  const start = new Array(n).fill(0);
  const end = new Array(n).fill(0);
  const crew = new Array(n).fill(0);
  for (const j of order) {
    let est = 0;
    for (const p of preds[j]) est = Math.max(est, end[p]);
    let kBest = 0;
    let eBest = Infinity;
    for (let k = 0; k < crews; k++) {
      const e = Math.max(avail[k], est) + durations[j];
      if (e < eBest) { eBest = e; kBest = k; }
    }
    start[j] = Math.max(avail[kBest], est);
    end[j] = start[j] + durations[j];
    crew[j] = kBest;
    avail[kBest] = end[j];
  }
  return { start, end, crew };
}

function sequenceFrom(start, crew, ids) {
  const order = ids.map((_, j) => j).sort((a, b) => {
    if (start[a] !== start[b]) return start[a] - start[b];
    if (crew[a] !== crew[b]) return crew[a] - crew[b];
    return ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0;
  });
  return order.map((j) => ids[j]);
}

function* topoOrders(preds) {
  const n = preds.length;
  const indeg = preds.map((p) => p.length);
  const succs = preds.map(() => []);
  preds.forEach((ps, j) => ps.forEach((p) => succs[p].push(j)));
  const done = new Array(n).fill(false);
  const current = [];
  function* rec(count) {
    if (count === n) {
      yield [...current];
      return;
    }
    for (let j = 0; j < n; j++) {
      if (done[j] || indeg[j] !== 0) continue;
      done[j] = true;
      current.push(j);
      for (const s of succs[j]) indeg[s]--;
      yield* rec(count + 1);
      for (const s of succs[j]) indeg[s]++;
      current.pop();
      done[j] = false;
    }
  }
  yield* rec(0);
}

function* modeCombos(tasks) {
  const n = tasks.length;
  const chosen = new Array(n).fill(0);
  function* rec(i) {
    if (i === n) {
      yield [...chosen];
      return;
    }
    for (let mi = 0; mi < tasks[i].modes.length; mi++) {
      chosen[i] = mi;
      yield* rec(i + 1);
    }
  }
  yield* rec(0);
}

function feasibleCombo(state, combo) {
  let cost = 0;
  const used = {};
  for (let j = 0; j < combo.length; j++) {
    const m = state.tasks[j].modes[combo[j]];
    cost += m.cost;
    for (const [p, q] of Object.entries(m.parts)) used[p] = (used[p] || 0) + q;
  }
  if (cost > state.budget) return false;
  for (const [p, q] of Object.entries(used)) {
    if (q > (state.parts[p] || 0)) return false;
  }
  return true;
}

function comboCost(state, combo) {
  return combo.reduce((acc, mi, j) => acc + state.tasks[j].modes[mi].cost, 0);
}

export function bruteForceReference(state) {
  const tasks = state.tasks;
  const n = tasks.length;
  const ids = tasks.map((t) => t.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const preds = tasks.map((t) => t.deps.map((d) => index.get(d)));
  let best = null;
  for (const combo of modeCombos(tasks)) {
    if (!feasibleCombo(state, combo)) continue;
    const cost = comboCost(state, combo);
    const durations = combo.map((mi, j) => tasks[j].modes[mi].duration);
    for (const order of topoOrders(preds)) {
      const { start, end, crew } = serialSchedule(order, durations, preds, state.crews);
      const downtime = end.reduce((a, b) => a + b, 0);
      const sequence = sequenceFrom(start, crew, ids);
      const cand = { status: 'optimal', downtime, cost, sequence };
      if (!best || better(cand, best)) best = cand;
    }
  }
  return best || { status: 'infeasible' };
}

export function bruteForceWithCrews(state) {
  const tasks = state.tasks;
  const n = tasks.length;
  const ids = tasks.map((t) => t.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const preds = tasks.map((t) => t.deps.map((d) => index.get(d)));
  let best = null;
  const assign = new Array(n).fill(0);
  function* crewAssigns() {
    function* rec(j) {
      if (j === n) {
        yield [...assign];
        return;
      }
      for (let k = 0; k < state.crews; k++) {
        assign[j] = k;
        yield* rec(j + 1);
      }
    }
    yield* rec(0);
  }
  for (const combo of modeCombos(tasks)) {
    if (!feasibleCombo(state, combo)) continue;
    const cost = comboCost(state, combo);
    const durations = combo.map((mi, j) => tasks[j].modes[mi].duration);
    for (const order of topoOrders(preds)) {
      for (const crewsOf of crewAssigns()) {
        // raw simulation on the assigned crew
        const avail = new Array(state.crews).fill(0);
        const rawStart = new Array(n).fill(0);
        for (const j of order) {
          let est = 0;
          for (const p of preds[j]) est = Math.max(est, rawStart[p] + durations[p]);
          rawStart[j] = Math.max(avail[crewsOf[j]], est);
          avail[crewsOf[j]] = rawStart[j] + durations[j];
        }
        // re-canonicalize: reschedule in (start, id) order
        const priority = ids
          .map((_, j) => j)
          .sort((a, b) => (rawStart[a] !== rawStart[b] ? rawStart[a] - rawStart[b] : ids[a] < ids[b] ? -1 : 1));
        const { start, end, crew } = serialSchedule(priority, durations, preds, state.crews);
        const downtime = end.reduce((a, b) => a + b, 0);
        const sequence = sequenceFrom(start, crew, ids);
        const cand = { status: 'optimal', downtime, cost, sequence };
        if (!best || better(cand, best)) best = cand;
      }
    }
  }
  return best || { status: 'infeasible' };
}
