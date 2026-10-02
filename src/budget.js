import { ReplanError } from './errors.js';
import { DIMS } from './dag.js';

export function parseBudget(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ReplanError('E_BUDGET', 'budget: expected an object with cpu/mem/wall');
  }
  const budget = {};
  for (const dim of DIMS) {
    const v = doc[dim];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new ReplanError('E_BUDGET', `budget: "${dim}" must be a non-negative number`);
    }
    budget[dim] = v;
  }
  return budget;
}

// NULL (unknown) resource cost participates as a conservative upper bound:
// it is charged the entire budget of that dimension. It is never treated as
// zero (free) and never as infinite (unschedulable).
export function effectiveCost(task, budget) {
  const out = {};
  for (const dim of DIMS) {
    out[dim] = task.cost[dim] === null ? budget[dim] : task.cost[dim];
  }
  return out;
}

export function addCost(acc, cost) {
  for (const dim of DIMS) acc[dim] += cost[dim];
}

export function subCost(acc, cost) {
  for (const dim of DIMS) acc[dim] -= cost[dim];
}

export function fits(cost, budget) {
  return DIMS.every((dim) => cost[dim] <= budget[dim]);
}
