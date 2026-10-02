// Exhaustive enumerator used to cross-check the solver on small instances
// (n <= 9 recipes). Shares all feasibility primitives with the solver.
import {
  assign,
  canAssign,
  createBatchState,
  isBetterSolution,
  numBatches,
  recipeValues,
  unassign,
} from './model.js';
import { requiredIdsOf } from './solver.js';

export function bruteForce(problem) {
  const config = problem.config;
  const required = new Set(requiredIdsOf(problem));
  const state = createBatchState(config);
  const assignment = new Map();
  const lockMap = new Map((problem.locks ?? []).map((l) => [l.recipe, l]));
  const nBatches = numBatches(config);

  const recipes = [...problem.recipes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let weight = 0;
  for (const r of recipes) {
    const lock = lockMap.get(r.id);
    if (!lock) continue;
    const value = { temp: lock.temp, atmo: lock.atmo, dur: lock.dur };
    if (!canAssign(config, state, r, value, lock.batch)) return null; // infeasible
    assign(config, state, r, value, lock.batch);
    assignment.set(r.id, { batch: lock.batch, value });
    weight += r.priority;
  }

  const remaining = recipes.filter((r) => !assignment.has(r.id));
  const valuesOf = new Map(remaining.map((r) => [r.id, recipeValues(r)]));
  let best = null;
  let nodes = 0;

  function recurse(i, w) {
    nodes += 1;
    if (i === remaining.length) {
      const ids = [...assignment.keys()].sort();
      const cand = { weight: w, ids, assignment: new Map(assignment) };
      if (!best || isBetterSolution(cand, best)) best = cand;
      return;
    }
    const r = remaining[i];
    for (let b = 0; b < nBatches; b++) {
      for (const v of valuesOf.get(r.id)) {
        if (!canAssign(config, state, r, v, b)) continue;
        assign(config, state, r, v, b);
        assignment.set(r.id, { batch: b, value: v });
        recurse(i + 1, w + r.priority);
        assignment.delete(r.id);
        unassign(config, state, r, v, b);
      }
    }
    if (!required.has(r.id)) recurse(i + 1, w);
  }

  recurse(0, weight);
  return { best, nodes };
}
