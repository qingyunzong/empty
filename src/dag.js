import { ReplanError } from './errors.js';

export const DIMS = ['cpu', 'mem', 'wall'];

// Parse and validate a DAG document: { tasks: [{ id, deps, cost, failRate, value, retries, failAttempts, crash }] }
// cost.<dim> may be null (unknown resource). failRate may be null (unknown history).
export function parseDag(doc) {
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.tasks)) {
    throw new ReplanError('E_USAGE', 'dag: expected an object with a "tasks" array');
  }
  const tasks = new Map();
  for (const raw of doc.tasks) {
    if (raw === null || typeof raw !== 'object') {
      throw new ReplanError('E_USAGE', 'dag: every task must be an object');
    }
    const id = raw.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new ReplanError('E_USAGE', 'dag: task missing a non-empty string "id"');
    }
    if (tasks.has(id)) {
      throw new ReplanError('E_USAGE', `dag: duplicate task id "${id}"`);
    }
    const deps = raw.deps ?? [];
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) {
      throw new ReplanError('E_USAGE', `dag: task "${id}" deps must be an array of strings`);
    }
    const rawCost = raw.cost ?? {};
    if (rawCost === null || typeof rawCost !== 'object') {
      throw new ReplanError('E_USAGE', `dag: task "${id}" cost must be an object`);
    }
    const cost = {};
    for (const dim of DIMS) {
      const v = rawCost[dim];
      if (v === null || v === undefined) {
        cost[dim] = null; // unknown resource: participates via conservative upper bound
      } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        cost[dim] = v;
      } else {
        throw new ReplanError('E_USAGE', `dag: task "${id}" cost.${dim} must be a non-negative number or null`);
      }
    }
    const failRate = raw.failRate ?? null;
    if (failRate !== null && (typeof failRate !== 'number' || !(failRate >= 0 && failRate <= 1))) {
      throw new ReplanError('E_USAGE', `dag: task "${id}" failRate must be in [0,1] or null`);
    }
    const value = raw.value ?? 1;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ReplanError('E_USAGE', `dag: task "${id}" value must be a finite number`);
    }
    const retries = raw.retries ?? 2;
    if (!Number.isInteger(retries) || retries < 0) {
      throw new ReplanError('E_USAGE', `dag: task "${id}" retries must be a non-negative integer`);
    }
    const failAttempts = raw.failAttempts ?? 0;
    if (!Number.isInteger(failAttempts) || failAttempts < 0) {
      throw new ReplanError('E_USAGE', `dag: task "${id}" failAttempts must be a non-negative integer`);
    }
    const crash = raw.crash ?? null;
    if (crash !== null && crash !== 'after-checkpoint') {
      throw new ReplanError('E_USAGE', `dag: task "${id}" crash must be "after-checkpoint" or null`);
    }
    tasks.set(id, { id, deps: [...new Set(deps)], cost, failRate, value, retries, failAttempts, crash });
  }
  for (const t of tasks.values()) {
    for (const d of t.deps) {
      if (!tasks.has(d)) {
        throw new ReplanError('E_UNKNOWN', `dag: task "${t.id}" depends on unknown task "${d}"`);
      }
    }
  }
  return tasks;
}

// Kahn's algorithm with lexicographic tie-break: fully deterministic order.
export function topoOrder(tasks) {
  const indeg = new Map();
  const dependents = new Map();
  for (const id of tasks.keys()) {
    indeg.set(id, 0);
    dependents.set(id, []);
  }
  for (const t of tasks.values()) {
    for (const d of t.deps) {
      indeg.set(t.id, indeg.get(t.id) + 1);
      dependents.get(d).push(t.id);
    }
  }
  const ready = [...tasks.keys()].filter((id) => indeg.get(id) === 0).sort();
  const order = [];
  const inOrder = new Set();
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    inOrder.add(id);
    for (const dep of dependents.get(id)) {
      indeg.set(dep, indeg.get(dep) - 1);
      if (indeg.get(dep) === 0) {
        const i = ready.findIndex((x) => x > dep);
        if (i === -1) ready.push(dep);
        else ready.splice(i, 0, dep);
      }
    }
  }
  if (order.length !== tasks.size) {
    const remaining = [...tasks.keys()].filter((id) => !inOrder.has(id)).sort();
    throw new ReplanError('E_CYCLE', `dag: cycle detected involving task(s): ${remaining.join(', ')}`);
  }
  return order;
}

// ids plus all transitive dependencies.
export function depClosure(tasks, ids) {
  const out = new Set();
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const d of tasks.get(id).deps) stack.push(d);
  }
  return out;
}

// ids plus all transitive dependents.
export function dependentClosure(tasks, ids) {
  const dependents = new Map();
  for (const id of tasks.keys()) dependents.set(id, []);
  for (const t of tasks.values()) {
    for (const d of t.deps) dependents.get(d).push(t.id);
  }
  const out = new Set();
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const d of dependents.get(id)) stack.push(d);
  }
  return out;
}
