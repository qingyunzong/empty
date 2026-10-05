'use strict';

const EPS = 1e-9;

class BudgetExhausted extends Error {
  constructor(pending) {
    super('branch budget exhausted');
    this.name = 'BudgetExhausted';
    this.pending = pending;
  }
}

// ---- cost tuples -----------------------------------------------------------
// A plan is compared by a lexicographic tuple, minimized:
//   [ shedAtLevel(maxLevel), ..., shedAtLevel(minLevel), shed(load by id asc)... ]
// i.e. shed the least possible at the highest importance level first; within a
// level, loads with smaller ids are spared first (ties broken by id).
function buildCostContext(model) {
  const levels = [...new Set(model.loads.map((l) => l.level))].sort((a, b) => b - a);
  const idOrder = model.loads
    .map((l, i) => ({ id: l.id, i }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => e.i);
  return { levels, idOrder };
}

function costTuple(model, ctx, shedOf) {
  const tuple = [];
  for (const level of ctx.levels) {
    let sum = 0;
    for (let i = 0; i < model.loads.length; i += 1) {
      if (model.loads[i].level === level) sum += shedOf(i);
    }
    tuple.push(sum);
  }
  for (const i of ctx.idOrder) tuple.push(shedOf(i));
  return tuple;
}

function compareTuples(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i] - EPS) return -1;
    if (a[i] > b[i] + EPS) return 1;
  }
  return 0;
}

// ---- solver context --------------------------------------------------------
function buildContext(model) {
  const n = model.loads.length;
  const indexOf = model.loadIndex;

  // union-find for "together" groups
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const next = parent[x]; parent[x] = r; x = next; }
    return r;
  };
  for (const lock of model.interlocks) {
    if (lock.type !== 'together') continue;
    const members = lock.loads.map((id) => indexOf.get(id));
    for (let i = 1; i < members.length; i += 1) {
      parent[find(members[i])] = find(members[0]);
    }
  }
  const groupMap = new Map();
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    if (!groupMap.has(r)) groupMap.set(r, []);
    groupMap.get(r).push(i);
  }
  const togetherGroups = [...groupMap.values()].filter((g) => g.length > 1);

  const orders = model.interlocks
    .filter((l) => l.type === 'order')
    .map((l) => ({ first: indexOf.get(l.first), then: indexOf.get(l.then) }));

  const noshed = model.interlocks
    .filter((l) => l.type === 'noshed')
    .map((l) => indexOf.get(l.load));

  const feederLoads = model.feeders.map((f) => f.loadIds.map((id) => indexOf.get(id)));

  return { togetherGroups, orders, noshed, feederLoads, cost: buildCostContext(model) };
}

function shedOf(model, i, stage) {
  return model.loads[i].shedPerStage * stage;
}

function intersectSorted(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(a[i]); i += 1; j += 1; }
    else if (a[i] < b[j]) i += 1;
    else j += 1;
  }
  return out;
}

// Arc-consistency style propagation over the finite stage domains.
// Mutates and returns `domains`, or returns null on a wiped-out domain.
function propagate(model, ctx, domains, gap) {
  const n = model.loads.length;
  let changed = true;
  while (changed) {
    changed = false;

    // together: all members share one stage domain
    for (const group of ctx.togetherGroups) {
      let inter = domains[group[0]];
      for (let k = 1; k < group.length && inter.length > 0; k += 1) {
        inter = intersectSorted(inter, domains[group[k]]);
      }
      if (inter.length === 0) return null;
      for (const i of group) {
        if (domains[i].length !== inter.length) {
          domains[i] = inter;
          changed = true;
        }
      }
    }

    // order: stage(first) >= stage(then)
    for (const { first, then } of ctx.orders) {
      const minThen = domains[then][0];
      const maxFirst = domains[first][domains[first].length - 1];
      const nf = domains[first].filter((s) => s >= minThen);
      const nt = domains[then].filter((s) => s <= maxFirst);
      if (nf.length === 0 || nt.length === 0) return null;
      if (nf.length !== domains[first].length) { domains[first] = nf; changed = true; }
      if (nt.length !== domains[then].length) { domains[then] = nt; changed = true; }
    }

    // feeder cumulative capacity: sum of shed on a feeder <= capacity
    for (let f = 0; f < model.feeders.length; f += 1) {
      const members = ctx.feederLoads[f];
      const cap = model.feeders[f].capacity;
      let minTotal = 0;
      for (const i of members) minTotal += shedOf(model, i, domains[i][0]);
      for (const i of members) {
        const allowed = cap - (minTotal - shedOf(model, i, domains[i][0]));
        const nd = domains[i].filter((s) => shedOf(model, i, s) <= allowed + EPS);
        if (nd.length === 0) return null;
        if (nd.length !== domains[i].length) { domains[i] = nd; changed = true; }
      }
    }

    // gap: total shed must be able to reach the deficit
    let maxTotal = 0;
    const maxShed = new Array(n);
    for (let i = 0; i < n; i += 1) {
      maxShed[i] = shedOf(model, i, domains[i][domains[i].length - 1]);
      maxTotal += maxShed[i];
    }
    if (maxTotal < gap - EPS) return null;
    for (let i = 0; i < n; i += 1) {
      const required = gap - (maxTotal - maxShed[i]);
      if (required <= EPS) continue;
      const nd = domains[i].filter((s) => shedOf(model, i, s) >= required - EPS);
      if (nd.length === 0) return null;
      if (nd.length !== domains[i].length) { domains[i] = nd; changed = true; }
    }
  }
  return domains;
}

function initialDomains(model, ctx) {
  return model.loads.map((load, i) => {
    if (load.fixedStage !== null) return [load.fixedStage];
    if (ctx.noshed.includes(i)) return [0];
    return Array.from({ length: load.maxStage + 1 }, (_, s) => s);
  });
}

// ---- minimal conflict ------------------------------------------------------
// Constraints that can cap the maximum achievable shed: feeder capacities,
// noshed locks, together groups (a noshed/fixed member caps the whole group).
function listConstraints(model, ctx) {
  const constraints = [];
  model.feeders.forEach((f, i) => constraints.push({ kind: 'feeder', id: f.id, index: i }));
  for (const lock of model.interlocks) {
    if (lock.type === 'noshed') {
      constraints.push({ kind: 'noshed', id: lock.load, index: model.loadIndex.get(lock.load) });
    } else if (lock.type === 'together') {
      constraints.push({ kind: 'together', id: lock.loads.join('+'), members: lock.loads.map((id) => model.loadIndex.get(id)) });
    } else if (lock.type === 'order') {
      constraints.push({ kind: 'order', id: `${lock.first}->${lock.then}` });
    }
  }
  return constraints;
}

function maxAchievableShed(model, ctx, relaxed) {
  const n = model.loads.length;
  const maxStage = model.loads.map((l) => (l.fixedStage !== null ? l.fixedStage : l.maxStage));
  for (const lock of model.interlocks) {
    if (lock.type === 'noshed' && !relaxed.has(`noshed:${lock.load}`)) {
      maxStage[model.loadIndex.get(lock.load)] = 0;
    }
  }
  for (const group of ctx.togetherGroups) {
    const key = `together:${group.map((i) => model.loads[i].id).sort().join('+')}`;
    if (relaxed.has(key)) continue;
    let m = Infinity;
    for (const i of group) m = Math.min(m, maxStage[i]);
    for (const i of group) maxStage[i] = m;
  }
  let total = 0;
  model.feeders.forEach((f, fi) => {
    let sum = 0;
    for (const i of ctx.feederLoads[fi]) sum += shedOf(model, i, maxStage[i]);
    if (!relaxed.has(`feeder:${f.id}`)) sum = Math.min(sum, f.capacity);
    total += sum;
  });
  return total;
}

function findConflict(model, ctx, gap) {
  const constraints = listConstraints(model, ctx);
  const keyOf = (c) => (c.kind === 'feeder' ? `feeder:${c.id}`
    : c.kind === 'noshed' ? `noshed:${c.id}`
    : c.kind === 'together' ? `together:${[...c.id.split('+')].sort().join('+')}`
    : `order:${c.id}`);

  const relaxable = constraints.filter((c) => c.kind !== 'order');
  const allKeys = new Set(relaxable.map(keyOf));
  const shedWith = (activeKeys) => maxAchievableShed(
    model,
    ctx,
    new Set([...allKeys].filter((k) => !activeKeys.has(k))),
  );

  const full = shedWith(allKeys);
  if (full >= gap - EPS) {
    // Max shed can reach the gap, yet no discrete stage assignment works
    // (order interlocks / stage granularity). Report everything involved.
    return {
      kind: 'discrete',
      gap,
      maxShed: full,
      constraints: constraints.map((c) => c.id),
    };
  }

  // Greedy deletion -> irreducible (minimal) infeasible core.
  const active = new Set(allKeys);
  for (const key of [...active]) {
    const trial = new Set(active);
    trial.delete(key);
    if (shedWith(trial) < gap - EPS) active.delete(key);
  }
  const core = relaxable.filter((c) => active.has(keyOf(c)));
  return {
    kind: 'capacity',
    gap,
    maxShed: shedWith(active),
    constraints: core.map((c) => c.id),
    feeders: core.filter((c) => c.kind === 'feeder').map((c) => c.id),
    loads: core.filter((c) => c.kind === 'noshed').map((c) => c.id),
    together: core.filter((c) => c.kind === 'together').map((c) => c.id),
  };
}

// ---- branch and bound ------------------------------------------------------
function solve(model, { gap, budget = Infinity } = {}) {
  if (typeof gap !== 'number' || !Number.isFinite(gap) || gap < 0) {
    throw new TypeError('gap must be a non-negative number');
  }
  const ctx = buildContext(model);
  const n = model.loads.length;

  let domains = initialDomains(model, ctx);
  domains = propagate(model, ctx, domains, gap);
  if (domains === null) {
    return { status: 'infeasible', conflict: findConflict(model, ctx, gap) };
  }

  let best = null;
  let nodes = 0;

  const lowerBoundTuple = (doms) => costTuple(model, ctx.cost, (i) => shedOf(model, i, doms[i][0]));

  const assignedStage = new Array(n).fill(null);

  function dfs(doms) {
    nodes += 1;
    if (nodes > budget) {
      const pending = [];
      for (let i = 0; i < n; i += 1) {
        if (doms[i].length > 1) pending.push(model.loads[i].id);
      }
      throw new BudgetExhausted(pending);
    }
    if (best && compareTuples(lowerBoundTuple(doms), best.tuple) >= 0) return;

    // singleton domains are forced; assign them without branching
    const forced = [];
    for (let i = 0; i < n; i += 1) {
      if (assignedStage[i] === null && doms[i].length === 1) {
        assignedStage[i] = doms[i][0];
        forced.push(i);
      }
    }

    // pick the unassigned load with the smallest domain (MRV)
    let pick = -1;
    for (let i = 0; i < n; i += 1) {
      if (assignedStage[i] !== null) continue;
      if (pick === -1 || doms[i].length < doms[pick].length) pick = i;
    }
    if (pick === -1) {
      const tuple = costTuple(model, ctx.cost, (i) => shedOf(model, i, assignedStage[i]));
      if (best === null || compareTuples(tuple, best.tuple) < 0) {
        best = { tuple, plan: assignedStage.slice() };
      }
      for (const i of forced) assignedStage[i] = null;
      return;
    }
    for (const stage of doms[pick]) {
      const next = doms.map((d) => d.slice());
      next[pick] = [stage];
      const pruned = propagate(model, ctx, next, gap);
      if (pruned === null) continue;
      assignedStage[pick] = stage;
      dfs(pruned);
      assignedStage[pick] = null;
    }
    for (const i of forced) assignedStage[i] = null;
  }

  try {
    dfs(domains);
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      const pending = err.pending.length > 0
        ? err.pending
        : model.loads.filter((l, i) => domains[i].length > 1).map((l) => l.id);
      return { status: 'unknown', pending, nodes };
    }
    throw err;
  }

  if (best === null) {
    return { status: 'infeasible', conflict: findConflict(model, ctx, gap) };
  }

  const plan = {};
  let shed = 0;
  model.loads.forEach((load, i) => {
    plan[load.id] = best.plan[i];
    shed += shedOf(model, i, best.plan[i]);
  });
  return { status: 'optimal', plan, shed, cost: best.tuple, nodes };
}

module.exports = { solve, findConflict, buildContext, propagate, costTuple, compareTuples, BudgetExhausted, EPS };
