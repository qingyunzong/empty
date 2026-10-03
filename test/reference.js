'use strict';

// Independent reference solver used by the acceptance tests.
// It enumerates, with no pruning and no shared search code:
//   1. every (defer | mode) combination per task,
//   2. every legal topological order of the scheduled tasks,
// and list-schedules each order deterministically (earliest feasible crew,
// lowest crew index on ties). The winner is chosen with the library's public
// total comparator, so ties are broken objectively.

const { makeCandidate, compareCandidates } = require('../src/solver');

function enumeratePlans(n, modeCounts) {
  const plans = [];
  const choice = new Array(n).fill(-1);
  function dfs(i) {
    if (i === n) {
      plans.push(choice.slice());
      return;
    }
    for (let m = -1; m < modeCounts[i]; m += 1) {
      choice[i] = m;
      dfs(i + 1);
    }
    choice[i] = -1;
  }
  dfs(0);
  return plans;
}

function planIsValid(problem, choice, indexOf) {
  let cost = 0;
  const usage = {};
  for (const name of Object.keys(problem.parts)) usage[name] = 0;
  for (let i = 0; i < problem.tasks.length; i += 1) {
    if (choice[i] < 0) continue;
    const task = problem.tasks[i];
    for (const dep of task.deps) {
      if (choice[indexOf.get(dep)] < 0) return false; // successor invalidation
    }
    const mode = task.modes[choice[i]];
    cost += mode.cost;
    for (const [part, qty] of Object.entries(mode.parts || {})) {
      usage[part] += qty;
      if (usage[part] > problem.parts[part]) return false;
    }
  }
  return cost <= problem.budget;
}

function enumerateTopoOrders(scheduled, preds) {
  const orders = [];
  const order = [];
  const placed = new Set();
  function dfs() {
    if (order.length === scheduled.length) {
      orders.push(order.slice());
      return;
    }
    for (const t of scheduled) {
      if (placed.has(t)) continue;
      let ready = true;
      for (const p of preds.get(t)) {
        if (scheduled.includes(p) && !placed.has(p)) { ready = false; break; }
      }
      if (!ready) continue;
      placed.add(t);
      order.push(t);
      dfs();
      order.pop();
      placed.delete(t);
    }
  }
  dfs();
  return orders;
}

function listSchedule(order, problem, choice, indexOf) {
  const crewFree = new Array(problem.crews).fill(0);
  const completion = new Map();
  const events = [];
  let downtime = 0;
  for (const id of order) {
    const i = indexOf.get(id);
    const task = problem.tasks[i];
    const duration = task.modes[choice[i]].duration;
    let predDone = 0;
    for (const dep of task.deps) {
      if (completion.has(dep) && completion.get(dep) > predDone) predDone = completion.get(dep);
    }
    let bestCrew = 0;
    let bestStart = Infinity;
    for (let c = 0; c < problem.crews; c += 1) {
      const s = Math.max(crewFree[c], predDone);
      if (s < bestStart) { bestStart = s; bestCrew = c; }
    }
    const end = bestStart + duration;
    crewFree[bestCrew] = end;
    completion.set(id, end);
    downtime += task.downtime * end;
    events.push({ id, start: bestStart, crew: bestCrew });
  }
  return { downtime, events };
}

function referenceSolve(problem) {
  const n = problem.tasks.length;
  const indexOf = new Map(problem.tasks.map((t, i) => [t.id, i]));
  const preds = new Map(problem.tasks.map((t) => [t.id, t.deps.slice()]));
  const plans = enumeratePlans(n, problem.tasks.map((t) => t.modes.length));
  let best = null;
  for (const choice of plans) {
    if (!planIsValid(problem, choice, indexOf)) continue;
    let cost = 0;
    let downtime = 0;
    const scheduled = [];
    const modeIds = problem.tasks.map((t, i) => (choice[i] >= 0 ? t.modes[choice[i]].id : ''));
    for (let i = 0; i < n; i += 1) {
      const t = problem.tasks[i];
      if (choice[i] >= 0) {
        cost += t.modes[choice[i]].cost;
        scheduled.push(t.id);
      } else {
        downtime += t.downtime * t.deferPenalty;
      }
    }
    for (const order of enumerateTopoOrders(scheduled, preds)) {
      const sched = listSchedule(order, problem, choice, indexOf);
      const cand = makeCandidate(downtime + sched.downtime, cost, sched.events, modeIds);
      if (!best || compareCandidates(cand, best) < 0) best = cand;
    }
  }
  return best;
}

module.exports = { referenceSolve };
