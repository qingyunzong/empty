'use strict';

// Discrete-time slot model. A task occupies slots [start, start + duration).
// Hard constraints: release <= start, start + duration <= due (when due set),
// precedence (before ends before after starts), per-line per-slot capacity.
// Objective: minimize max lateness (completion - due over tasks with a due),
// ties broken by the lexicographically smallest start-time vector in
// ascending task-id order. All solves are exhaustive (no timeouts), so an
// "infeasible" answer is a proof, not a search artifact.

function horizonOf(problem) {
  let sumDuration = 0;
  let maxRelease = 0;
  let maxDue = 0;
  for (const task of problem.tasks.values()) {
    sumDuration += task.duration;
    maxRelease = Math.max(maxRelease, task.release);
    if (task.due !== null) maxDue = Math.max(maxDue, task.due);
  }
  // Any feasible/optimal schedule fits inside [0, maxRelease + sumDuration):
  // sequencing all tasks back to back after the last release always works.
  return Math.max(maxRelease + sumDuration, maxDue, 1);
}

function capacityAt(problem, line, slot) {
  const slots = problem.capacity[line];
  if (slots) {
    const key = String(slot);
    if (Object.prototype.hasOwnProperty.call(slots, key)) return slots[key];
    if (Object.prototype.hasOwnProperty.call(slots, '*')) return slots['*'];
  }
  return problem.defaultCapacity;
}

function hasPrecedenceCycle(problem) {
  const indegree = new Map();
  const adjacency = new Map();
  for (const id of problem.tasks.keys()) {
    indegree.set(id, 0);
    adjacency.set(id, []);
  }
  for (const [before, after] of problem.precedence) {
    adjacency.get(before).push(after);
    indegree.set(after, indegree.get(after) + 1);
  }
  const queue = [];
  for (const [id, degree] of indegree) {
    if (degree === 0) queue.push(id);
  }
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.pop();
    visited += 1;
    for (const next of adjacency.get(id)) {
      const degree = indegree.get(next) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  return visited !== problem.tasks.size;
}

function compareVectors(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Main exact solver. Depth-first enumeration of start times in task-id order
// with ascending start values, i.e. lexicographic enumeration of start
// vectors, plus safe pruning on the lateness bound. options.fixed pins some
// tasks to given starts (used for local repair); fixed tasks consume capacity.
function solve(problem, options = {}) {
  const infeasible = { feasible: false };
  const fixed = options.fixed instanceof Map
    ? options.fixed
    : new Map(Object.entries(options.fixed ?? {}));
  const horizon = horizonOf(problem);
  if (hasPrecedenceCycle(problem)) return infeasible;
  const ids = [...problem.tasks.keys()].sort();

  const lines = new Set();
  for (const task of problem.tasks.values()) lines.add(task.line);
  const remaining = new Map();
  for (const line of lines) {
    const slots = new Array(horizon);
    for (let slot = 0; slot < horizon; slot += 1) {
      slots[slot] = capacityAt(problem, line, slot);
    }
    remaining.set(line, slots);
  }

  for (const [id, start] of fixed) {
    const task = problem.tasks.get(id);
    if (!task) return infeasible;
    if (!Number.isInteger(start) || start < 0 || start + task.duration > horizon) {
      return infeasible;
    }
    const slots = remaining.get(task.line);
    for (let slot = start; slot < start + task.duration; slot += 1) {
      slots[slot] -= 1;
      if (slots[slot] < 0) return infeasible;
    }
  }

  const earliest = new Map();
  const latest = new Map();
  for (const id of ids) {
    if (fixed.has(id)) continue;
    const task = problem.tasks.get(id);
    let upper = horizon - task.duration;
    if (task.due !== null) upper = Math.min(upper, task.due - task.duration);
    earliest.set(id, task.release);
    latest.set(id, upper);
  }
  for (const [before, after] of problem.precedence) {
    const beforeTask = problem.tasks.get(before);
    const afterTask = problem.tasks.get(after);
    const fixedBefore = fixed.has(before) ? fixed.get(before) : null;
    const fixedAfter = fixed.has(after) ? fixed.get(after) : null;
    if (fixedBefore !== null && fixedAfter !== null) {
      if (fixedBefore + beforeTask.duration > fixedAfter) return infeasible;
    } else if (fixedBefore !== null) {
      earliest.set(after, Math.max(earliest.get(after), fixedBefore + beforeTask.duration));
    } else if (fixedAfter !== null) {
      latest.set(before, Math.min(latest.get(before), fixedAfter - afterTask.duration));
    }
  }

  const domains = new Map();
  for (const id of ids) {
    if (fixed.has(id)) continue;
    const task = problem.tasks.get(id);
    const slots = remaining.get(task.line);
    const domain = [];
    for (let start = earliest.get(id); start <= latest.get(id); start += 1) {
      let fits = true;
      for (let slot = start; slot < start + task.duration; slot += 1) {
        if (slots[slot] <= 0) { fits = false; break; }
      }
      if (fits) domain.push(start);
    }
    if (domain.length === 0) return infeasible;
    domains.set(id, domain);
  }

  const freeIds = ids.filter((id) => !fixed.has(id));
  const predecessors = new Map();
  const successors = new Map();
  for (const id of freeIds) {
    predecessors.set(id, []);
    successors.set(id, []);
  }
  for (const [before, after] of problem.precedence) {
    if (!fixed.has(before) && !fixed.has(after)) {
      successors.get(before).push(after);
      predecessors.get(after).push(before);
    }
  }

  const starts = new Map(fixed);
  let fixedLateness = -Infinity;
  for (const [id, start] of fixed) {
    const task = problem.tasks.get(id);
    if (task.due !== null) {
      fixedLateness = Math.max(fixedLateness, start + task.duration - task.due);
    }
  }

  let bestLateness = Infinity;
  let bestVector = null;
  let bestStarts = null;

  const dfs = (index, partialLateness) => {
    if (partialLateness > bestLateness) return;
    if (index === freeIds.length) {
      const vector = ids.map((id) => starts.get(id));
      if (partialLateness < bestLateness || bestVector === null
          || compareVectors(vector, bestVector) < 0) {
        bestLateness = partialLateness;
        bestVector = vector;
        bestStarts = new Map(starts);
      }
      return;
    }
    const id = freeIds[index];
    const task = problem.tasks.get(id);
    const slots = remaining.get(task.line);
    for (const start of domains.get(id)) {
      let ok = true;
      for (const pred of predecessors.get(id)) {
        if (starts.has(pred) && starts.get(pred) + problem.tasks.get(pred).duration > start) {
          ok = false;
          break;
        }
      }
      if (ok) {
        for (const succ of successors.get(id)) {
          if (starts.has(succ) && start + task.duration > starts.get(succ)) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      for (let slot = start; slot < start + task.duration; slot += 1) {
        if (slots[slot] <= 0) { ok = false; break; }
      }
      if (!ok) continue;
      for (let slot = start; slot < start + task.duration; slot += 1) slots[slot] -= 1;
      starts.set(id, start);
      const lateness = task.due !== null
        ? Math.max(partialLateness, start + task.duration - task.due)
        : partialLateness;
      dfs(index + 1, lateness);
      starts.delete(id);
      for (let slot = start; slot < start + task.duration; slot += 1) slots[slot] += 1;
    }
  };
  dfs(0, fixedLateness);

  if (bestVector === null) return infeasible;
  return { feasible: true, lmax: bestLateness, starts: bestStarts, horizon };
}

// Independent reference implementation: plain cartesian enumeration of every
// slot assignment, used to cross-validate solve() on small instances (<= 8
// tasks). Deliberately shares no search code with solve().
function bruteForce(problem) {
  const infeasible = { feasible: false };
  const horizon = horizonOf(problem);
  if (hasPrecedenceCycle(problem)) return infeasible;
  const ids = [...problem.tasks.keys()].sort();
  const indexOf = new Map(ids.map((id, i) => [id, i]));
  const domains = ids.map((id) => {
    const task = problem.tasks.get(id);
    let upper = horizon - task.duration;
    if (task.due !== null) upper = Math.min(upper, task.due - task.duration);
    const domain = [];
    for (let start = task.release; start <= upper; start += 1) domain.push(start);
    return domain;
  });
  if (domains.some((domain) => domain.length === 0)) return infeasible;

  const starts = new Array(ids.length).fill(0);
  let best = null;
  const recurse = (index) => {
    if (index === ids.length) {
      for (const [before, after] of problem.precedence) {
        const beforeTask = problem.tasks.get(before);
        if (starts[indexOf.get(before)] + beforeTask.duration > starts[indexOf.get(after)]) {
          return;
        }
      }
      const usage = new Map();
      for (let i = 0; i < ids.length; i += 1) {
        const task = problem.tasks.get(ids[i]);
        for (let slot = starts[i]; slot < starts[i] + task.duration; slot += 1) {
          const key = task.line + '|' + slot;
          const used = (usage.get(key) ?? 0) + 1;
          if (used > capacityAt(problem, task.line, slot)) return;
          usage.set(key, used);
        }
      }
      let lmax = -Infinity;
      for (let i = 0; i < ids.length; i += 1) {
        const task = problem.tasks.get(ids[i]);
        if (task.due !== null) {
          lmax = Math.max(lmax, starts[i] + task.duration - task.due);
        }
      }
      const vector = [...starts];
      if (!best || lmax < best.lmax
          || (lmax === best.lmax && compareVectors(vector, best.vector) < 0)) {
        best = { lmax, vector };
      }
      return;
    }
    for (const start of domains[index]) {
      starts[index] = start;
      recurse(index + 1);
    }
  };
  recurse(0);

  if (!best) return infeasible;
  const startMap = new Map();
  ids.forEach((id, i) => startMap.set(id, best.vector[i]));
  return { feasible: true, lmax: best.lmax, starts: startMap, horizon };
}

module.exports = { solve, bruteForce, horizonOf, capacityAt, hasPrecedenceCycle, compareVectors };
