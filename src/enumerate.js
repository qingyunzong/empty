import {
  compilePool,
  initialState,
  stateKey,
  enabledSteps,
  applyStep,
  violatingAccount,
} from './model.js';

// Main enumerator. Because used/frozen are fully determined by the per-task
// status vector, the reachable state space is at most 5^tasks, so a memoized
// DFS counts every legal (maximal feasible) schedule exactly, while a BFS
// over the same state graph yields the shortest, lexicographically smallest
// violating step sequence.

export class StateExplosionError extends Error {
  constructor(limit) {
    super(`state space exceeds limit of ${limit} explored states`);
    this.name = 'StateExplosionError';
    this.code = 'STATE_EXPLOSION';
  }
}

const DEFAULT_MAX_STATES = 5_000_000;

function countSchedules(model, maxStates) {
  const memo = new Map();
  let statesExplored = 0;
  let violated = false;
  let maxLoad = 0;
  let maxLoadAccount = null;

  function dfs(state) {
    const key = stateKey(state);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    statesExplored += 1;
    if (statesExplored > maxStates) throw new StateExplosionError(maxStates);
    for (let i = 0; i < model.accounts.length; i += 1) {
      const load = state.used[i] + state.frozen[i];
      if (load > model.accounts[i].limit) violated = true;
      if (load > maxLoad) {
        maxLoad = load;
        maxLoadAccount = model.accounts[i].id;
      }
    }
    let total = 0n;
    for (const step of enabledSteps(model, state)) {
      const next = applyStep(model, state, step.task, step.phase);
      if (next !== null) total += dfs(next);
    }
    if (total === 0n) total = 1n; // maximal feasible sequence: one legal schedule ends here
    memo.set(key, total);
    return total;
  }

  const legalSchedules = dfs(initialState(model));
  return { legalSchedules, statesExplored, violated, maxLoad, maxLoadAccount };
}

function comparePaths(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// BFS level by level; parents are expanded in lexicographic path order and
// children in label order, so the first violating state found corresponds to
// the shortest, lexicographically smallest violating step sequence.
function shortestViolation(model) {
  const init = initialState(model);
  let frontier = [{ state: init, path: [] }];
  const seen = new Set([stateKey(init)]);
  while (frontier.length > 0) {
    frontier.sort((a, b) => comparePaths(a.path, b.path));
    const nextFrontier = new Map();
    for (const node of frontier) {
      for (const step of enabledSteps(model, node.state)) {
        const next = applyStep(model, node.state, step.task, step.phase);
        if (next === null) continue;
        const path = [...node.path, step.label];
        const bad = violatingAccount(model, next);
        if (bad !== -1) {
          return {
            steps: path,
            account: model.accounts[bad].id,
            used: next.used[bad],
            frozen: next.frozen[bad],
            limit: model.accounts[bad].limit,
          };
        }
        const key = stateKey(next);
        if (!seen.has(key) && !nextFrontier.has(key)) {
          nextFrontier.set(key, { state: next, path });
        }
      }
    }
    for (const key of nextFrontier.keys()) seen.add(key);
    frontier = [...nextFrontier.values()];
  }
  return null;
}

export function analyzeModel(model, { maxStates = DEFAULT_MAX_STATES } = {}) {
  const counts = countSchedules(model, maxStates);
  const violation = counts.violated ? shortestViolation(model) : null;
  return {
    legalSchedules: counts.legalSchedules,
    statesExplored: counts.statesExplored,
    violated: counts.violated,
    verdict: counts.violated ? 'VIOLATION' : 'SAFE',
    violation,
    maxLoad: counts.maxLoad,
    maxLoadAccount: counts.maxLoadAccount,
  };
}

export function analyzePool(pool, options) {
  return analyzeModel(compilePool(pool), options);
}
