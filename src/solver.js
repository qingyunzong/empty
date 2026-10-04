// Finite-domain CSP solver: stage domains per load, constraint propagation
// (feeder cumulative capacity, interlocks, gap reachability) plus
// branch-and-bound backtracking with a node budget.
//
// Objective (lexicographic, encoded as one BigInt):
//   1. minimize importance-weighted shed: sum_i shed_i * M^level_i
//      (lower levels are always preferred over higher ones),
//   2. tie-break by load id order (lower id sheds first).

export class BudgetExhausted extends Error {}

export function totalMaxShed(model) {
  return model.loads.reduce((sum, load) => sum + load.shed[model.stages], 0);
}

function makeCostTerms(model) {
  const { loads } = model;
  const M = BigInt(totalMaxShed(model) + 1);
  const tieSpan = BigInt(loads.length + 1);
  // ranks: position in id-sorted order, used for deterministic tie-breaking
  const sorted = [...loads.keys()].sort((a, b) => (loads[a].id < loads[b].id ? -1 : 1));
  const rank = new Array(loads.length);
  sorted.forEach((loadIndex, r) => { rank[loadIndex] = r; });
  return loads.map((load, i) => {
    const weight = M ** BigInt(load.level) * tieSpan;
    const tie = BigInt(rank[i]);
    return load.shed.map((amount) => weight * BigInt(amount) + tie * BigInt(amount));
  });
}

export function assignmentCost(model, assignment) {
  const terms = makeCostTerms(model);
  return assignment.reduce((sum, stage, i) => sum + terms[i][stage], 0n);
}

export function assignmentShed(model, assignment) {
  return assignment.reduce((sum, stage, i) => sum + model.loads[i].shed[stage], 0);
}

// Check a complete assignment against every constraint. Returns null when
// valid, otherwise a human-readable violation description.
export function checkPlan(model, assignment, gap) {
  const { loads, feeders, interlocks, stages: K } = model;
  for (let i = 0; i < loads.length; i += 1) {
    const s = assignment[i];
    if (!Number.isInteger(s) || s < 0 || s > K) {
      return `load "${loads[i].id}": invalid stage ${s}`;
    }
  }
  if (assignmentShed(model, assignment) < gap) {
    return `shed ${assignmentShed(model, assignment)} below gap ${gap}`;
  }
  for (const feeder of feeders) {
    for (let s = 0; s <= K; s += 1) {
      const cap = feeder.capacity[s];
      if (cap === Infinity) continue;
      let cumulative = 0;
      for (const i of feeder.loads) {
        if (assignment[i] <= s) cumulative += loads[i].shed[assignment[i]];
      }
      if (cumulative > cap) {
        return `feeder "${feeder.id}": cumulative shed ${cumulative} exceeds capacity ${cap} at stage ${s}`;
      }
    }
  }
  for (const interlock of interlocks) {
    const [a, b] = interlock.loads;
    if (interlock.type === 'together') {
      const stage = assignment[a];
      if (interlock.loads.some((i) => assignment[i] !== stage)) {
        return `interlock together violated: ${interlock.loadIds.join(', ')}`;
      }
    } else if (interlock.type === 'sequence') {
      if (assignment[a] > assignment[b]) {
        return `interlock sequence violated: ${interlock.loadIds.join(' -> ')}`;
      }
    } else if (interlock.type === 'unsheddable') {
      if (interlock.loads.some((i) => assignment[i] !== 0)) {
        return `interlock unsheddable violated: ${interlock.loadIds.join(', ')}`;
      }
    }
  }
  return null;
}

function initialDomains(model) {
  return model.loads.map((load, i) => {
    const domain = [];
    for (let s = 0; s <= model.stages; s += 1) domain.push(s);
    return domain;
  });
}

// Constraint propagation to a fixpoint. Returns pruned domains, or null on
// a detected dead end (some domain emptied or the gap became unreachable).
export function propagate(model, domains, gap) {
  const { loads, feeders, interlocks, stages: K } = model;
  const doms = domains.map((d) => d.slice());

  const restrict = (i, keep) => {
    const next = doms[i].filter(keep);
    if (next.length === 0) return false;
    if (next.length !== doms[i].length) {
      doms[i] = next;
      return true;
    }
    return false;
  };

  let changed = true;
  while (changed) {
    changed = false;

    for (const interlock of interlocks) {
      if (interlock.type === 'unsheddable') {
        for (const i of interlock.loads) {
          if (restrict(i, (s) => s === 0)) changed = true;
          if (doms[i].length === 0) return null;
        }
      } else if (interlock.type === 'together') {
        let common = new Set(doms[interlock.loads[0]]);
        for (const i of interlock.loads.slice(1)) {
          common = new Set(doms[i].filter((s) => common.has(s)));
        }
        if (common.size === 0) return null;
        for (const i of interlock.loads) {
          if (restrict(i, (s) => common.has(s))) changed = true;
          if (doms[i].length === 0) return null;
        }
      } else if (interlock.type === 'sequence') {
        const [a, b] = interlock.loads;
        const maxB = Math.max(...doms[b]);
        if (restrict(a, (s) => s <= maxB)) changed = true;
        if (doms[a].length === 0) return null;
        const minA = Math.min(...doms[a]);
        if (restrict(b, (s) => s >= minA)) changed = true;
        if (doms[b].length === 0) return null;
      }
    }

    // Feeder cumulative capacity: at stage s a load contributes its shed
    // amount only when its assigned stage is <= s.
    for (const feeder of feeders) {
      for (let s = 0; s <= K; s += 1) {
        const cap = feeder.capacity[s];
        if (cap === Infinity) continue;
        const minContrib = feeder.loads.map((i) => {
          let best = Infinity;
          for (const t of doms[i]) {
            const c = t <= s ? loads[i].shed[t] : 0;
            if (c < best) best = c;
          }
          return best;
        });
        const totalMin = minContrib.reduce((a, b) => a + b, 0);
        if (totalMin > cap) return null;
        feeder.loads.forEach((i, pos) => {
          const others = totalMin - minContrib[pos];
          if (restrict(i, (t) => (t <= s ? loads[i].shed[t] : 0) + others <= cap)) changed = true;
        });
        if (feeder.loads.some((i) => doms[i].length === 0)) return null;
      }
    }

    // Gap reachability: prune stages that can never add up to the gap even
    // when every other load sheds its domain maximum.
    let maxShed = 0;
    const maxEach = loads.map((load, i) => {
      let best = 0;
      for (const t of doms[i]) best = Math.max(best, load.shed[t]);
      maxShed += best;
      return best;
    });
    if (maxShed < gap) return null;
    for (let i = 0; i < loads.length; i += 1) {
      const others = maxShed - maxEach[i];
      if (restrict(i, (t) => loads[i].shed[t] + others >= gap)) changed = true;
      if (doms[i].length === 0) return null;
    }
  }
  return doms;
}

// Solve the model. Options:
//   gap      required deficit (non-negative integer)
//   budget   maximum number of branch nodes (default 1e6)
//   findFirst  stop at the first feasible plan (used by conflict analysis)
// Returns one of:
//   { status: 'ok', plan, shed, cost, nodes, optimal: true|false }
//   { status: 'infeasible', nodes }
//   { status: 'unknown', pending: [loadIds], incumbent, nodes }
export function solve(model, { gap, budget = 1_000_000, findFirst = false } = {}) {
  const { loads } = model;
  const costTerms = makeCostTerms(model);
  let nodes = 0;
  let exhausted = false;
  let pendingSnapshot = null;
  let best = null;

  const root = propagate(model, initialDomains(model), gap);
  if (root === null) return { status: 'infeasible', nodes };

  const lowerBound = (doms) => {
    let lb = 0n;
    for (let i = 0; i < loads.length; i += 1) {
      let min = null;
      for (const t of doms[i]) {
        const c = costTerms[i][t];
        if (min === null || c < min) min = c;
      }
      lb += min;
    }
    return lb;
  };

  const costOf = (doms) => {
    let cost = 0n;
    for (let i = 0; i < loads.length; i += 1) cost += costTerms[i][doms[i][0]];
    return cost;
  };

  const shedOf = (doms) => {
    let shed = 0;
    for (let i = 0; i < loads.length; i += 1) shed += loads[i].shed[doms[i][0]];
    return shed;
  };

  const dfs = (doms) => {
    if (exhausted) return;
    if (best !== null && lowerBound(doms) >= best.cost) return;

    let pick = -1;
    for (let i = 0; i < loads.length; i += 1) {
      if (doms[i].length > 1 && (pick === -1 || doms[i].length < doms[pick].length)) pick = i;
    }

    if (pick === -1) {
      const shed = shedOf(doms);
      if (shed >= gap) {
        const cost = costOf(doms);
        if (best === null || cost < best.cost) {
          best = {
            plan: Object.fromEntries(loads.map((load, i) => [load.id, doms[i][0]])),
            shed,
            cost,
          };
        }
      }
      return;
    }

    for (const stage of doms[pick]) {
      if (nodes >= budget) {
        exhausted = true;
        pendingSnapshot = loads
          .filter((_, i) => doms[i].length > 1)
          .map((load) => load.id);
        return;
      }
      nodes += 1;
      const next = doms.map((d) => d.slice());
      next[pick] = [stage];
      const pruned = propagate(model, next, gap);
      if (pruned !== null) dfs(pruned);
      if (exhausted) return;
      if (findFirst && best !== null) return;
    }
  };

  dfs(root);

  if (exhausted) {
    return {
      status: 'unknown',
      pending: pendingSnapshot ?? loads.map((load) => load.id),
      incumbent: best,
      nodes,
    };
  }
  if (best === null) return { status: 'infeasible', nodes };
  return { status: 'ok', ...best, nodes, optimal: true };
}
