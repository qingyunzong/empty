import {
  assign,
  canAssign,
  createBatchState,
  dayOfBatch,
  gasOf,
  isBetterSolution,
  numBatches,
  recipeValues,
  unassign,
  validateConfig,
  validateRecipe,
} from './model.js';

export class BudgetExhausted extends Error {
  constructor(kind) {
    super(`budget exhausted: ${kind}`);
    this.kind = kind;
  }
}

// Generous but finite budgets for the internal minimal-core sub-solves.
const CORE_BUDGETS = { propagate: 2_000_000, backtrack: 2_000_000, improve: 1_000_000 };

export function requiredIdsOf(problem) {
  const threshold = problem.config?.requiredPriority ?? Number.POSITIVE_INFINITY;
  const locked = new Set((problem.locks ?? []).map((l) => l.recipe));
  return problem.recipes
    .filter((r) => locked.has(r.id) || r.priority >= threshold)
    .map((r) => r.id);
}

export function solve(problem, budgets = {}, opts = {}) {
  validateConfig(problem.config);
  for (const r of problem.recipes) validateRecipe(r);
  const required = new Set(opts.requiredIds ?? requiredIdsOf(problem));
  const result = search(problem, budgets, required);
  if (result.status === 'UNSAT' && opts.core !== false) {
    result.core = minimalCore(problem, required);
  }
  return result;
}

function formatAssignment(config, assignment) {
  const out = {};
  for (const [id, a] of [...assignment.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    out[id] = {
      batch: a.batch,
      day: dayOfBatch(config, a.batch),
      temp: a.value.temp,
      atmo: a.value.atmo,
      dur: a.value.dur,
    };
  }
  return out;
}

function search(problem, budgets, required) {
  const config = problem.config;
  const budget = {
    propagate: budgets.propagate ?? Number.POSITIVE_INFINITY,
    backtrack: budgets.backtrack ?? Number.POSITIVE_INFINITY,
    improve: budgets.improve ?? Number.POSITIVE_INFINITY,
  };
  const spend = (kind) => {
    if (budget[kind] <= 0) throw new BudgetExhausted(kind);
    budget[kind] -= 1;
  };

  const lockMap = new Map((problem.locks ?? []).map((l) => [l.recipe, l]));
  const state = createBatchState(config);
  const assignment = new Map(); // id -> { batch, value }
  const nBatches = numBatches(config);

  // Decision order: required first, then priority desc, then recipe id asc.
  const ordered = [...problem.recipes].sort((a, b) => {
    const ra = required.has(a.id) ? 0 : 1;
    const rb = required.has(b.id) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Apply locks up front; a clashing lock makes the instance infeasible.
  let weight = 0;
  for (const r of ordered) {
    const lock = lockMap.get(r.id);
    if (!lock) continue;
    const value = { temp: lock.temp, atmo: lock.atmo, dur: lock.dur };
    spend('propagate');
    if (!canAssign(config, state, r, value, lock.batch)) {
      return { status: 'UNSAT', objective: null, assignment: null, unscheduled: null, bound: { lower: 0, upper: 0 } };
    }
    assign(config, state, r, value, lock.batch);
    assignment.set(r.id, { batch: lock.batch, value });
    weight += r.priority;
  }

  const remaining = ordered.filter((r) => !assignment.has(r.id));
  const valuesOf = new Map(remaining.map((r) => [r.id, recipeValues(r)]));
  const suffix = new Array(remaining.length + 1).fill(0);
  for (let i = remaining.length - 1; i >= 0; i--) {
    suffix[i] = suffix[i + 1] + Math.max(0, remaining[i].priority);
  }

  let best = null; // { weight, ids, assignment }
  const stackBounds = [];

  // Resource-profile lower-bound propagation (forward checking):
  //  - every undecided required recipe must keep some feasible (batch, value);
  //  - recipes forced onto a single day must jointly fit that day's remaining
  //    gas budget (using each recipe's minimum feasible gas) and free slots.
  function propagateOk(nextIndex) {
    const forcedGas = new Array(config.days).fill(0);
    const forcedCount = new Array(config.days).fill(0);
    for (let j = nextIndex; j < remaining.length; j++) {
      const r = remaining[j];
      if (!required.has(r.id)) continue;
      const dayMinGas = new Array(config.days).fill(Number.POSITIVE_INFINITY);
      for (let b = 0; b < nBatches; b++) {
        for (const v of valuesOf.get(r.id)) {
          spend('propagate');
          if (canAssign(config, state, r, v, b)) {
            const d = dayOfBatch(config, b);
            const g = gasOf(config, v);
            if (g < dayMinGas[d]) dayMinGas[d] = g;
          }
        }
      }
      let possibleDays = 0;
      let lastDay = -1;
      for (let d = 0; d < config.days; d++) {
        if (dayMinGas[d] !== Number.POSITIVE_INFINITY) {
          possibleDays += 1;
          lastDay = d;
        }
      }
      if (possibleDays === 0) return false;
      if (possibleDays === 1) {
        forcedGas[lastDay] += dayMinGas[lastDay];
        forcedCount[lastDay] += 1;
        if (forcedGas[lastDay] > config.gasBudget - state.dayGas[lastDay]) return false;
        let freeSlots = 0;
        const first = lastDay * config.maxRunsPerDay;
        for (let b = first; b < first + config.maxRunsPerDay; b++) {
          freeSlots += config.slots - state.batches[b].members.length;
        }
        if (forcedCount[lastDay] > freeSlots) return false;
      }
    }
    return true;
  }

  function recurse(i, w) {
    spend('backtrack');
    const bound = w + suffix[i];
    stackBounds.push(bound);
    try {
      if (best && bound < best.weight) return;
      if (i === remaining.length) {
        const ids = [...assignment.keys()].sort();
        const cand = { weight: w, ids, assignment: new Map(assignment) };
        if (!best || isBetterSolution(cand, best)) {
          spend('improve');
          best = cand;
        }
        return;
      }
      const r = remaining[i];
      for (let b = 0; b < nBatches; b++) {
        for (const v of valuesOf.get(r.id)) {
          spend('propagate');
          if (!canAssign(config, state, r, v, b)) continue;
          assign(config, state, r, v, b);
          assignment.set(r.id, { batch: b, value: v });
          if (propagateOk(i + 1)) recurse(i + 1, w + r.priority);
          assignment.delete(r.id);
          unassign(config, state, r, v, b);
        }
      }
      if (!required.has(r.id)) recurse(i + 1, w);
    } finally {
      stackBounds.pop();
    }
  }

  try {
    if (propagateOk(0)) recurse(0, weight);
  } catch (e) {
    if (e instanceof BudgetExhausted) {
      const upper = Math.max(best ? best.weight : 0, ...stackBounds);
      return {
        status: 'PENDING',
        reason: e.kind,
        objective: best ? best.weight : null,
        assignment: best ? formatAssignment(config, best.assignment) : null,
        unscheduled: null,
        bound: { lower: best ? best.weight : 0, upper },
      };
    }
    throw e;
  }

  if (!best) {
    return { status: 'UNSAT', objective: null, assignment: null, unscheduled: null, bound: { lower: 0, upper: 0 } };
  }
  const scheduled = new Set(best.assignment.keys());
  return {
    status: 'OPTIMAL',
    objective: best.weight,
    assignment: formatAssignment(config, best.assignment),
    unscheduled: problem.recipes.map((r) => r.id).filter((id) => !scheduled.has(id)).sort(),
    bound: { lower: best.weight, upper: best.weight },
  };
}

// Deletion-minimal unsat core over the required recipe set: repeatedly drop a
// required recipe; if the instance stays infeasible, the drop is kept.
function minimalCore(problem, required) {
  let core = [...required].sort();
  for (const id of [...core]) {
    const trialRequired = new Set(core.filter((x) => x !== id));
    const trial = {
      config: problem.config,
      recipes: problem.recipes,
      locks: (problem.locks ?? []).filter((l) => trialRequired.has(l.recipe)),
    };
    const res = search(trial, CORE_BUDGETS, trialRequired);
    if (res.status === 'UNSAT') {
      core = core.filter((x) => x !== id);
    }
  }
  return core;
}
