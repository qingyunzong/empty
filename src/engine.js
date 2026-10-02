import { computeResultHash } from './canonical.js';

function cloneTasks(tasks) {
  const out = {};
  for (const [id, t] of Object.entries(tasks)) {
    out[id] = { input: t.input, version: t.version, deps: [...t.deps] };
  }
  return out;
}

function sortedUniqueDeps(deps) {
  return [...new Set(deps)].sort();
}

// Layered topological order: predecessors first; tasks in the same layer are
// ordered by id ascending. Returns null when the graph contains a cycle
// (including self-loops).
export function topoSort(tasks) {
  const ids = Object.keys(tasks).sort();
  const remaining = new Map();
  const dependents = new Map();
  for (const id of ids) {
    const deps = sortedUniqueDeps(tasks[id].deps);
    remaining.set(id, deps.length);
    for (const d of deps) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(id);
    }
  }
  let layer = ids.filter((id) => remaining.get(id) === 0);
  const order = [];
  while (layer.length > 0) {
    layer.sort();
    const next = [];
    for (const id of layer) {
      order.push(id);
      for (const dep of dependents.get(id) ?? []) {
        remaining.set(dep, remaining.get(dep) - 1);
        if (remaining.get(dep) === 0) next.push(dep);
      }
    }
    layer = next;
  }
  if (order.length !== ids.length) return null;
  return order;
}

function computeAll(tasks, order) {
  const hashes = {};
  for (const id of order) {
    const deps = sortedUniqueDeps(tasks[id].deps);
    hashes[id] = computeResultHash(tasks[id], deps.map((d) => [d, hashes[d]]));
  }
  return hashes;
}

function validateRefs(tasks) {
  for (const [id, t] of Object.entries(tasks)) {
    for (const d of t.deps) {
      if (!Object.hasOwn(tasks, d)) {
        return { ok: false, error: 'E_UNKNOWN_TASK', task: id, missing: d };
      }
    }
  }
  return null;
}

// Build the initial state: validates references and acyclicity, then computes
// every task hash from scratch in layered topological order.
export function initState(taskDefs) {
  const tasks = cloneTasks(taskDefs);
  const badRef = validateRefs(tasks);
  if (badRef) return badRef;
  const order = topoSort(tasks);
  if (!order) return { ok: false, error: 'E_CYCLE' };
  const hashes = computeAll(tasks, order);
  return { ok: true, state: { tasks, hashes }, order };
}

function specOf(task) {
  return JSON.stringify([task.input, task.version, sortedUniqueDeps(task.deps)]);
}

function buildDependents(tasks) {
  const dependents = new Map();
  for (const [id, t] of Object.entries(tasks)) {
    for (const d of sortedUniqueDeps(t.deps)) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(id);
    }
  }
  return dependents;
}

// Apply one transaction atomically.
// tx = { setInput?, setVersion?, addDeps?, removeDeps? }
// options.maxRecompute caps the number of tasks that may be recomputed.
// On E_CYCLE / E_BUDGET / E_UNKNOWN_TASK the state is left untouched.
export function applyTransaction(state, tx = {}, options = {}) {
  const maxRecompute = options.maxRecompute ?? Infinity;
  const tasks = cloneTasks(state.tasks);

  for (const [id, input] of Object.entries(tx.setInput ?? {})) {
    if (!tasks[id]) return { ok: false, error: 'E_UNKNOWN_TASK', task: id };
    tasks[id].input = input;
  }
  for (const [id, version] of Object.entries(tx.setVersion ?? {})) {
    if (!tasks[id]) return { ok: false, error: 'E_UNKNOWN_TASK', task: id };
    tasks[id].version = version;
  }
  for (const [id, adds] of Object.entries(tx.addDeps ?? {})) {
    if (!tasks[id]) return { ok: false, error: 'E_UNKNOWN_TASK', task: id };
    tasks[id].deps = sortedUniqueDeps([...tasks[id].deps, ...adds]);
  }
  for (const [id, removes] of Object.entries(tx.removeDeps ?? {})) {
    if (!tasks[id]) return { ok: false, error: 'E_UNKNOWN_TASK', task: id };
    const drop = new Set(removes);
    tasks[id].deps = tasks[id].deps.filter((d) => !drop.has(d));
  }

  const badRef = validateRefs(tasks);
  if (badRef) return badRef;

  const order = topoSort(tasks);
  if (!order) return { ok: false, error: 'E_CYCLE' };

  // Directly invalidated: the declared spec changed.
  const direct = [];
  for (const id of Object.keys(tasks)) {
    if (specOf(tasks[id]) !== specOf(state.tasks[id])) direct.push(id);
  }

  // Invalidation closure: direct changes plus all transitive dependents.
  const dependents = buildDependents(tasks);
  const invalidated = new Set(direct);
  const queue = [...direct];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const dep of dependents.get(id) ?? []) {
      if (!invalidated.has(dep)) {
        invalidated.add(dep);
        queue.push(dep);
      }
    }
  }

  if (invalidated.size > maxRecompute) {
    return {
      ok: false,
      error: 'E_BUDGET',
      needed: invalidated.size,
      budget: maxRecompute,
    };
  }

  // Recompute only the invalidated closure, in layered topological order
  // (same layer ordered by id ascending), each task exactly once.
  const recomputed = order.filter((id) => invalidated.has(id));
  const hashes = { ...state.hashes };
  const diff = {};
  for (const id of recomputed) {
    const deps = sortedUniqueDeps(tasks[id].deps);
    const next = computeResultHash(tasks[id], deps.map((d) => [d, hashes[d]]));
    if (next !== state.hashes[id]) {
      diff[id] = { from: state.hashes[id], to: next };
    }
    hashes[id] = next;
  }

  // Stop points: recomputed tasks with no dependent inside the invalidated
  // closure — the frontier where the recomputation wave halts.
  const stopPoints = recomputed.filter(
    (id) => !(dependents.get(id) ?? []).some((d) => invalidated.has(d)),
  );

  // Commit only on success.
  state.tasks = tasks;
  state.hashes = hashes;

  return { ok: true, recomputed, diff, stopPoints, hashes };
}
