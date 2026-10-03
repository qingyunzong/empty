// Wave planner: assigns every requested task a route and a shuttle under hard
// battery constraints (per-shuttle battery and wave budget). Objective tuple,
// minimized lexicographically:
//   1. makespan (completion time: max over shuttles of summed move durations)
//   2. total energy
//   3. plan path signature (per-task route lane sequences, tasks sorted by id)
//   4. reuse count (more reused moves preferred; from rollback pool hints)
//   5. assignment vector (per-task [shuttleIndex, routeIndex], tasks by id)

export function aggregateRoute(route) {
  let energy = 0;
  let duration = 0;
  const path = [];
  for (const mv of route.moves) {
    energy += mv.energy;
    duration += mv.duration;
    path.push(mv.lane);
  }
  return { energy, duration, path };
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function comparePaths(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmpStr(String(a[i]), String(b[i]));
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function compareSignatures(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = comparePaths(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function compareNumArrays(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function compareCandidates(x, y) {
  if (x.makespan !== y.makespan) return x.makespan - y.makespan;
  if (x.energy !== y.energy) return x.energy - y.energy;
  const sig = compareSignatures(x.signature, y.signature);
  if (sig !== 0) return sig;
  if (x.reuseCount !== y.reuseCount) return y.reuseCount - x.reuseCount;
  return compareNumArrays(x.vec, y.vec);
}

function orderInputs(tasks, shuttles) {
  const orderedTasks = [...tasks].sort((a, b) => cmpStr(a.id, b.id));
  const orderedShuttles = [...shuttles].sort((a, b) => cmpStr(a.id, b.id));
  return { orderedTasks, orderedShuttles };
}

export function planWave({ tasks, shuttles, budget, reuseHints = new Set() }) {
  const { orderedTasks, orderedShuttles } = orderInputs(tasks, shuttles);
  const n = orderedTasks.length;
  const routeAggs = orderedTasks.map((t) => t.routes.map(aggregateRoute));
  const loads = new Array(orderedShuttles.length).fill(0);
  const used = new Array(orderedShuttles.length).fill(0);
  const chosen = new Array(n);
  let best = null;

  function dfs(i, totalEnergy) {
    if (i === n) {
      const makespan = loads.length === 0 ? 0 : Math.max(...loads);
      const signature = chosen.map((c, k) => routeAggs[k][c.route].path);
      const vec = [];
      let reuseCount = 0;
      chosen.forEach((c, k) => {
        if (reuseHints.has(`${orderedTasks[k].id}:${c.route}`)) reuseCount++;
        vec.push(c.shuttle, c.route);
      });
      const cand = {
        makespan,
        energy: totalEnergy,
        signature,
        reuseCount,
        vec,
        assignments: chosen.map((c, k) => ({
          task: orderedTasks[k].id,
          route: c.route,
          shuttle: orderedShuttles[c.shuttle].id,
        })),
      };
      if (!best || compareCandidates(cand, best) < 0) best = cand;
      return;
    }
    for (let r = 0; r < routeAggs[i].length; r++) {
      const ag = routeAggs[i][r];
      for (let s = 0; s < orderedShuttles.length; s++) {
        if (used[s] + ag.energy > orderedShuttles[s].battery) continue;
        if (totalEnergy + ag.energy > budget) continue;
        loads[s] += ag.duration;
        used[s] += ag.energy;
        let pruned = false;
        if (best) {
          const partialMax = Math.max(...loads);
          const partialEnergy = totalEnergy + ag.energy;
          if (partialMax > best.makespan) pruned = true;
          else if (partialMax === best.makespan && partialEnergy > best.energy) pruned = true;
        }
        if (!pruned) {
          chosen[i] = { route: r, shuttle: s };
          dfs(i + 1, totalEnergy + ag.energy);
        }
        loads[s] -= ag.duration;
        used[s] -= ag.energy;
      }
    }
  }

  dfs(0, 0);
  return best;
}

export function canSchedule(tasks, shuttles, budget) {
  const { orderedTasks, orderedShuttles } = orderInputs(tasks, shuttles);
  const routeAggs = orderedTasks.map((t) => t.routes.map(aggregateRoute));
  const used = new Array(orderedShuttles.length).fill(0);

  function dfs(i, totalEnergy) {
    if (i === orderedTasks.length) return true;
    for (let r = 0; r < routeAggs[i].length; r++) {
      const ag = routeAggs[i][r];
      for (let s = 0; s < orderedShuttles.length; s++) {
        if (used[s] + ag.energy > orderedShuttles[s].battery) continue;
        if (totalEnergy + ag.energy > budget) continue;
        used[s] += ag.energy;
        if (dfs(i + 1, totalEnergy + ag.energy)) return true;
        used[s] -= ag.energy;
      }
    }
    return false;
  }

  return dfs(0, 0);
}

function compareStrArrays(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmpStr(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

// Minimal reduction set: fewest tasks to remove so the rest become schedulable.
// Ties: least removed energy (per-task minimum-route energy), then task ids
// lexicographically. Exhaustive for small waves; greedy fallback beyond 20.
export function minimalCut(tasks, shuttles, budget) {
  const { orderedTasks } = orderInputs(tasks, shuttles);
  const minEnergy = new Map(
    orderedTasks.map((t) => [t.id, Math.min(...t.routes.map((r) => aggregateRoute(r).energy))]),
  );
  const demand = orderedTasks.reduce((sum, t) => sum + minEnergy.get(t.id), 0);
  const n = orderedTasks.length;

  if (n > 20) {
    const remaining = new Map(orderedTasks.map((t) => [t.id, t]));
    const cut = [];
    const byEnergyDesc = [...orderedTasks].sort(
      (a, b) => minEnergy.get(b.id) - minEnergy.get(a.id) || cmpStr(a.id, b.id),
    );
    for (const t of byEnergyDesc) {
      if (canSchedule([...remaining.values()], shuttles, budget)) break;
      remaining.delete(t.id);
      cut.push(t.id);
    }
    cut.sort();
    const removedEnergy = cut.reduce((sum, id) => sum + minEnergy.get(id), 0);
    return { cut, removedEnergy, demand, deficit: demand - budget };
  }

  const subsets = [];
  for (let mask = 0; mask < 1 << n; mask++) {
    const ids = [];
    let removed = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        ids.push(orderedTasks[i].id);
        removed += minEnergy.get(orderedTasks[i].id);
      }
    }
    subsets.push({ ids, removed });
  }
  subsets.sort(
    (a, b) =>
      a.ids.length - b.ids.length || a.removed - b.removed || compareStrArrays(a.ids, b.ids),
  );
  for (const sub of subsets) {
    const cutSet = new Set(sub.ids);
    const remaining = orderedTasks.filter((t) => !cutSet.has(t.id));
    if (canSchedule(remaining, shuttles, budget)) {
      return { cut: sub.ids, removedEnergy: sub.removed, demand, deficit: demand - budget };
    }
  }
  return { cut: orderedTasks.map((t) => t.id), removedEnergy: demand, demand, deficit: demand - budget };
}
