// Schedule enumerator.
//
// Explores every legal interleaving of task steps: steps of one participant
// keep their reserve-before-complete order, steps of different participants
// may interleave freely. A step is only explored when the model accepts it;
// anything the model rejects with INVALID_MODEL simply is not a legal
// schedule. The safety invariant is checked in every visited state.
//
// Schedule counting uses memoized DFS over the (small) reachable state
// space, so the exact number of legal schedules is computed without walking
// each one. When a violation exists, a BFS finds the shortest violating
// sequence, ties broken lexicographically.

export function splitLabel(label) {
  const i = label.lastIndexOf(':');
  return [label.slice(0, i), label.slice(i + 1)];
}

function comparePaths(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export function enumerateSchedules(model, { collect = false } = {}) {
  model.reset();
  const memo = new Map();
  const terminalPaths = collect ? [] : null;
  const path = [];
  let statesVisited = 0;
  let transitions = 0;
  let invariantChecks = 0;
  let violation = null;

  function dfs() {
    invariantChecks += 1;
    if (violation === null && !model.invariantHolds()) {
      violation = [...path];
    }
    const key = model.key();
    if (!terminalPaths) {
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
    }
    statesVisited += 1;
    const steps = model.enabledSteps();
    if (steps.length === 0) {
      if (terminalPaths) terminalPaths.push([...path]);
      memo.set(key, 1n);
      return 1n;
    }
    const snap = model.snapshot();
    let total = 0n;
    for (const label of steps) {
      const [taskId, phase] = splitLabel(label);
      model.apply(taskId, phase);
      transitions += 1;
      path.push(label);
      total += dfs();
      path.pop();
      model.restore(snap);
    }
    if (!terminalPaths) memo.set(key, total);
    return total;
  }

  const scheduleCount = dfs();
  const shortest = violation !== null ? shortestViolation(model) : null;
  model.reset();
  return {
    safe: violation === null,
    scheduleCount,
    statesVisited,
    transitions,
    invariantChecks,
    violation: shortest,
    terminalPaths,
  };
}

// Shortest violating step sequence; ties broken lexicographically.
// Returns null when no reachable state violates the invariant.
export function shortestViolation(model) {
  model.reset();
  if (!model.invariantHolds()) return [];
  let level = new Map([[model.key(), { snap: model.snapshot(), path: [] }]]);
  const seen = new Set(level.keys());
  while (level.size > 0) {
    const entries = [...level.values()].sort((a, b) => comparePaths(a.path, b.path));
    const next = new Map();
    for (const { snap, path } of entries) {
      model.restore(snap);
      const steps = model.enabledSteps();
      for (const label of steps) {
        model.restore(snap);
        const [taskId, phase] = splitLabel(label);
        model.apply(taskId, phase);
        const candidate = [...path, label];
        if (!model.invariantHolds()) {
          model.reset();
          return candidate;
        }
        const key = model.key();
        if (!seen.has(key) && !next.has(key)) {
          next.set(key, { snap: model.snapshot(), path: candidate });
        }
      }
    }
    for (const key of next.keys()) seen.add(key);
    level = next;
  }
  model.reset();
  return null;
}
