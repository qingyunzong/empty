import {
  compilePool,
  initialState,
  enabledSteps,
  applyStep,
  violatingAccount,
  isMaximal,
} from './model.js';

// Independent cross-check enumerator for small pools (<= 3 tasks): it
// enumerates ALL permutations of the 2T steps, filters out permutations that
// break a task's reserve-before-complete order, simulates each remaining
// permutation while skipping momentarily infeasible steps, and keeps the
// executed sequence when it is maximal. This shares only the state-transition
// function with the main enumerator, not the enumeration strategy.

function* permutations(n) {
  const items = Array.from({ length: n }, (_, i) => i);
  function* rec(k) {
    if (k === items.length) {
      yield items.slice();
      return;
    }
    for (let i = k; i < items.length; i += 1) {
      [items[k], items[i]] = [items[i], items[k]];
      yield* rec(k + 1);
      [items[k], items[i]] = [items[i], items[k]];
    }
  }
  yield* rec(0);
}

function comparePaths(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export function bruteForceAnalyze(pool) {
  const model = compilePool(pool);
  const t = model.tasks.length;
  if (2 * t > 8) {
    throw new RangeError(`brute-force enumerator supports at most 4 tasks, got ${t}`);
  }
  const steps = [];
  for (const task of model.tasks) {
    steps.push({ task: task.index, phase: 'reserve', label: `${task.id}.reserve` });
    steps.push({ task: task.index, phase: 'complete', label: `${task.id}.complete` });
  }
  const legal = new Set();
  let violation = null;

  for (const perm of permutations(2 * t)) {
    // Filter: each task's reserve must precede its complete.
    const pos = new Array(2 * t);
    perm.forEach((stepIdx, i) => {
      pos[stepIdx] = i;
    });
    let ordered = true;
    for (let task = 0; task < t; task += 1) {
      if (pos[2 * task] > pos[2 * task + 1]) {
        ordered = false;
        break;
      }
    }
    if (!ordered) continue;

    let state = initialState(model);
    const executed = [];
    for (const stepIdx of perm) {
      const step = steps[stepIdx];
      const next = applyStep(model, state, step.task, step.phase);
      if (next === null) continue; // momentarily infeasible: skipped
      state = next;
      executed.push(step.label);
      const bad = violatingAccount(model, state);
      if (bad !== -1) {
        const candidate = {
          steps: executed.slice(),
          account: model.accounts[bad].id,
          used: state.used[bad],
          frozen: state.frozen[bad],
          limit: model.accounts[bad].limit,
        };
        if (
          violation === null ||
          candidate.steps.length < violation.steps.length ||
          (candidate.steps.length === violation.steps.length &&
            comparePaths(candidate.steps, violation.steps) < 0)
        ) {
          violation = candidate;
        }
      }
    }
    if (isMaximal(model, state)) legal.add(executed.join(' '));
  }

  return {
    legalSchedules: BigInt(legal.size),
    violated: violation !== null,
    verdict: violation !== null ? 'VIOLATION' : 'SAFE',
    violation,
  };
}
