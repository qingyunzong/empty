import { ReplanError } from './errors.js';
import { DIMS, EPS, effectiveCost, fits, successInterval } from './resources.js';

export const MAX_EXACT_TASKS = 30;

// Exact optimal planner.
// A plan is a dependency-closed subset of tasks whose cumulative effective
// cost fits the budget in every dimension. The objective is to maximize the
// summed task value. Every tied optimum is enumerated and returned in a
// deterministic order (sorted by the plan key: comma-joined sorted task ids).
export function planAll(dag, budget, opts = {}) {
  const requireIds = opts.require ?? [];
  const dropIds = opts.drop ?? [];
  const ids = dag.ids;
  const n = ids.length;
  if (n > MAX_EXACT_TASKS) {
    throw new ReplanError('E_INPUT', `exact planner supports at most ${MAX_EXACT_TASKS} tasks, got ${n}`);
  }
  const index = new Map(ids.map((id, i) => [id, i]));
  const bit = (i) => 2 ** i;
  for (const id of [...requireIds, ...dropIds]) {
    if (!index.has(id)) throw new ReplanError('E_INPUT', `unknown task: "${id}"`);
  }

  const closeMask = ids.map((id) => {
    let m = bit(index.get(id));
    for (const a of dag.ancestors(id)) m += bit(index.get(a));
    return m;
  });
  const costs = ids.map((id) => effectiveCost(dag.tasks.get(id), budget));
  const values = ids.map((id) => dag.tasks.get(id).value);

  const droppedMask = dropIds.reduce((m, id) => m + bit(index.get(id)), 0);
  let baseMask = 0;
  for (const id of requireIds) baseMask |= closeMask[index.get(id)];
  if (baseMask & droppedMask) {
    throw new ReplanError('E_INPUT', 'required tasks depend on dropped tasks');
  }

  const sumCost = (mask) => {
    const c = { cpu: 0, mem: 0, wall: 0 };
    for (let i = 0; i < n; i++) {
      if (mask & bit(i)) for (const d of DIMS) c[d] += costs[i][d];
    }
    return c;
  };
  const sumVal = (mask) => {
    let v = 0;
    for (let i = 0; i < n; i++) if (mask & bit(i)) v += values[i];
    return v;
  };

  const baseCost = sumCost(baseMask);
  if (!fits(baseCost, budget)) {
    throw new ReplanError('E_BUDGET', 'required tasks exceed the budget', {
      require: requireIds, cost: baseCost, budget,
    });
  }
  const baseVal = sumVal(baseMask);

  const candIdx = [];
  for (let i = 0; i < n; i++) {
    if (baseMask & bit(i)) continue;
    if (droppedMask & bit(i)) continue;
    if (closeMask[i] & droppedMask) continue; // would re-introduce a dropped task
    candIdx.push(i);
  }
  const m = candIdx.length;
  const suffix = new Array(m + 1).fill(0);
  for (let j = m - 1; j >= 0; j--) suffix[j] = suffix[j + 1] + values[candIdx[j]];

  let best = baseVal;
  let ties = [baseMask];
  const seen = new Set([baseMask]);

  function recurse(mask, cost, val, start) {
    for (let j = start; j < m; j++) {
      if (val + suffix[j] < best - EPS) break; // value upper bound cannot reach best
      const i = candIdx[j];
      const add = closeMask[i] & ~mask;
      if (add === 0) continue; // already implied by the current closed set
      const nmask = mask + add;
      if (seen.has(nmask)) continue;
      seen.add(nmask);
      const addCost = sumCost(add);
      const ncost = { cpu: cost.cpu + addCost.cpu, mem: cost.mem + addCost.mem, wall: cost.wall + addCost.wall };
      if (!fits(ncost, budget)) continue;
      const nval = val + sumVal(add);
      if (nval > best + EPS) {
        best = nval;
        ties = [nmask];
      } else if (nval >= best - EPS) {
        ties.push(nmask);
      }
      recurse(nmask, ncost, nval, j + 1);
    }
  }
  recurse(baseMask, baseCost, baseVal, 0);

  const plans = ties
    .map((mask) => maskToPlan(ids, bit, mask, sumCost(mask), sumVal(mask)))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { value: best, plans, budget, require: requireIds, drop: dropIds };
}

function maskToPlan(ids, bit, mask, cost, value) {
  const tasks = [];
  for (let i = 0; i < ids.length; i++) if (mask & bit(i)) tasks.push(ids[i]);
  return { key: tasks.join(','), tasks, cost, value };
}

// Report helper: reproducibility interval and recovery points of a plan.
export function planReport(dag, plan) {
  let lo = 1, hi = 1;
  for (const id of plan.tasks) {
    const [l, h] = successInterval(dag.tasks.get(id));
    lo *= l;
    hi *= h;
  }
  const inPlan = new Set(plan.tasks);
  const recoveryPoints = plan.tasks.map((id) => ({
    task: id,
    resumeAfter: dag.ancestors(id).filter((a) => inPlan.has(a)),
    checkpoint: `checkpoints/${id}.<attempt>.json`,
    maxAttempts: dag.tasks.get(id).maxRetries + 1,
  }));
  return { ...plan, reproducibility: [lo, hi], recoveryPoints };
}
