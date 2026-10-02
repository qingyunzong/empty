import { DEFAULT_MAX_RETRIES } from './dag.js';

export const DIMS = ['cpu', 'mem', 'wall'];
export const EPS = 1e-9;

// NULL resource semantics: an unknown consumption is not infinite and not
// zero — it participates at its conservative upper bound, which is the whole
// budget of that dimension (nothing runnable can exceed the total budget).
// If the budget dimension itself is unknown (null), it is unconstrained and
// the unknown consumption contributes 0 to that dimension's sum.
export function effectiveCost(task, budget) {
  const out = {};
  for (const d of DIMS) {
    const v = task[d];
    if (v === null || v === undefined) {
      out[d] = budget && budget[d] !== null && budget[d] !== undefined ? budget[d] : 0;
    } else {
      out[d] = v;
    }
  }
  return out;
}

export function fits(cost, budget) {
  return firstViolation(cost, budget) === null;
}

export function firstViolation(cost, budget) {
  for (const d of DIMS) {
    const b = budget ? budget[d] : null;
    if (b === null || b === undefined) continue; // unknown budget: dimension unconstrained
    if (cost[d] > b + EPS) return d;
  }
  return null;
}

export function addCost(acc, cost) {
  for (const d of DIMS) acc[d] += cost[d];
  return acc;
}

export function zeroCost() {
  return { cpu: 0, mem: 0, wall: 0 };
}

// Failure-rate intervals: unknown (null) rates enter as the full interval
// [0,1]; they never make a task unschedulable.
export function failInterval(task) {
  const p = task.failRate;
  return p === null || p === undefined ? [0, 1] : [p, p];
}

export function successInterval(task) {
  const r = (task.maxRetries ?? DEFAULT_MAX_RETRIES) + 1;
  const [lo, hi] = failInterval(task);
  return [1 - hi ** r, 1 - lo ** r];
}

function expectedAttempts(p, attempts) {
  if (p >= 1) return attempts;
  return (1 - p ** attempts) / (1 - p);
}

export function attemptsInterval(task) {
  const r = (task.maxRetries ?? DEFAULT_MAX_RETRIES) + 1;
  const [lo, hi] = failInterval(task);
  return [expectedAttempts(lo, r), expectedAttempts(hi, r)];
}
