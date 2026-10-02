import { ReplanError } from './errors.js';
import { DIMS, topoOrder, depClosure } from './dag.js';
import { effectiveCost, addCost, subCost } from './budget.js';

// Exact optimal planner: enumerates all dependency-closed, budget-feasible
// subsets (topo-ordered recursion with upper-bound pruning) and returns EVERY
// plan tied at the optimal value, sorted by a deterministic key
// (task ids sorted, joined with NUL). No randomness anywhere.
//
// opts:
//   require: ids that must be selected (their dep closure is forced too)
//   exclude: ids that must not be selected
//   done:    ids already completed (count as satisfied deps, zero cost/value)
export function findOptimalPlans(tasks, budget, opts = {}) {
  const require = new Set(opts.require ?? []);
  const exclude = new Set(opts.exclude ?? []);
  const done = new Set(opts.done ?? []);
  for (const id of [...require, ...exclude, ...done]) {
    if (!tasks.has(id)) throw new ReplanError('E_UNKNOWN', `plan: unknown task "${id}"`);
  }
  for (const id of require) {
    if (exclude.has(id)) throw new ReplanError('E_BUDGET', `plan: task "${id}" is both required and excluded`);
  }

  const order = topoOrder(tasks).filter((id) => !done.has(id));
  const indexOf = new Map(order.map((id, i) => [id, i]));

  // Required dependency closure must be selectable and must fit the budget.
  const required = depClosure(tasks, [...require].filter((id) => !done.has(id)));
  for (const id of required) {
    if (exclude.has(id)) {
      throw new ReplanError('E_BUDGET', `plan: required set depends on excluded task "${id}"`);
    }
  }
  const reqCost = { cpu: 0, mem: 0, wall: 0 };
  for (const id of required) addCost(reqCost, effectiveCost(tasks.get(id), budget));
  for (const dim of DIMS) {
    if (reqCost[dim] > budget[dim]) {
      throw new ReplanError('E_BUDGET', `plan: required tasks exceed budget.${dim} (${reqCost[dim]} > ${budget[dim]})`);
    }
  }

  // Suffix upper bound of attainable value, for pruning only (over-estimate).
  const suffix = new Array(order.length + 1).fill(0);
  for (let i = order.length - 1; i >= 0; i--) {
    const v = exclude.has(order[i]) ? 0 : Math.max(0, tasks.get(order[i]).value);
    suffix[i] = suffix[i + 1] + v;
  }

  let best = -Infinity;
  let bestPlans = [];
  const chosen = new Array(order.length).fill(false);
  const curCost = { cpu: 0, mem: 0, wall: 0 };
  let curValue = 0;

  const depsChosen = (t) => {
    for (const d of t.deps) {
      if (done.has(d)) continue;
      if (!chosen[indexOf.get(d)]) return false;
    }
    return true;
  };

  const record = () => {
    const ids = order.filter((_, i) => chosen[i]).sort();
    if (curValue > best) {
      best = curValue;
      bestPlans = [ids];
    } else if (curValue === best) {
      bestPlans.push(ids);
    }
  };

  const rec = (i) => {
    if (curValue + suffix[i] < best) return;
    if (i === order.length) {
      record();
      return;
    }
    const id = order[i];
    const t = tasks.get(id);
    if (!exclude.has(id) && depsChosen(t)) {
      const c = effectiveCost(t, budget);
      if (curCost.cpu + c.cpu <= budget.cpu &&
          curCost.mem + c.mem <= budget.mem &&
          curCost.wall + c.wall <= budget.wall) {
        chosen[i] = true;
        addCost(curCost, c);
        curValue += t.value;
        rec(i + 1);
        curValue -= t.value;
        subCost(curCost, c);
        chosen[i] = false;
      }
    }
    if (!required.has(id)) rec(i + 1);
  };
  rec(0);

  bestPlans.sort((a, b) => {
    const ka = a.join('\0');
    const kb = b.join('\0');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return { value: best, plans: bestPlans };
}

export function planCost(tasks, budget, ids) {
  const cost = { cpu: 0, mem: 0, wall: 0 };
  for (const id of ids) addCost(cost, effectiveCost(tasks.get(id), budget));
  return cost;
}

// Deterministic single plan choice: first of the sorted tie list.
export function choosePlan(tasks, budget, opts = {}) {
  const { value, plans } = findOptimalPlans(tasks, budget, opts);
  return { value, tasks: plans[0], all: plans };
}
