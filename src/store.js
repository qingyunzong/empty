import { createHash } from 'node:crypto';
import { canonicalJSON } from './canonical.js';

// Result hash of a task: sha256 over the canonical JSON of its predecessor
// result hashes (sorted by predecessor id), its input hash and module version.
export function hashResult(decl, depHashes) {
  const payload = canonicalJSON({
    deps: depHashes,
    inputHash: decl.inputHash,
    moduleVersion: decl.moduleVersion,
  });
  return createHash('sha256').update(payload).digest('hex');
}

function err(code, extra = {}) {
  return { ok: false, error: { code, ...extra } };
}

function normalizeTask(raw) {
  return {
    id: raw.id,
    inputHash: raw.inputHash ?? '',
    moduleVersion: raw.moduleVersion ?? '',
    deps: [...new Set(raw.deps ?? [])].sort(),
    resultHash: raw.resultHash ?? null,
  };
}

function sameDeps(a, b) {
  return a.length === b.length && a.every((d, i) => d === b[i]);
}

function findCycle(tasks) {
  const color = new Map(); // 1 = on stack, 2 = done
  const stack = [];
  const visit = (id) => {
    color.set(id, 1);
    stack.push(id);
    for (const dep of tasks.get(id).deps) {
      const c = color.get(dep) ?? 0;
      if (c === 1) return [...stack.slice(stack.indexOf(dep)), dep];
      if (c === 0) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const id of [...tasks.keys()].sort()) {
    if (!color.get(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

// Layered topological order of `subset`: layer 0 = no dependency inside the
// subset, layer k = 1 + max layer of in-subset deps. Same layer sorted by id
// ascending, so execution order is fully deterministic.
function layeredOrder(tasks, subset) {
  const layers = new Map();
  const layerOf = (id) => {
    if (layers.has(id)) return layers.get(id);
    let layer = 0;
    for (const dep of tasks.get(id).deps) {
      if (subset.has(dep)) layer = Math.max(layer, layerOf(dep) + 1);
    }
    layers.set(id, layer);
    return layer;
  };
  return [...subset].sort((a, b) => {
    const diff = layerOf(a) - layerOf(b);
    return diff !== 0 ? diff : a < b ? -1 : a > b ? 1 : 0;
  });
}

function buildDependents(tasks) {
  const dependents = new Map([...tasks.keys()].map((id) => [id, []]));
  for (const [id, task] of tasks) {
    for (const dep of task.deps) dependents.get(dep).push(id);
  }
  for (const list of dependents.values()) list.sort();
  return dependents;
}

function applyOp(tasks, op) {
  const target = typeof op.task === 'string' ? tasks.get(op.task) : undefined;
  switch (op.type) {
    case 'setModuleVersion': {
      if (!target) return err('E_UNKNOWN_TASK', { task: op.task });
      target.moduleVersion = op.moduleVersion ?? '';
      return null;
    }
    case 'setInput': {
      if (!target) return err('E_UNKNOWN_TASK', { task: op.task });
      target.inputHash = op.inputHash ?? '';
      return null;
    }
    case 'addDep': {
      if (!target) return err('E_UNKNOWN_TASK', { task: op.task });
      if (!tasks.has(op.dep)) return err('E_UNKNOWN_TASK', { task: op.dep, referencedBy: op.task });
      if (!target.deps.includes(op.dep)) {
        target.deps.push(op.dep);
        target.deps.sort();
      }
      return null;
    }
    case 'removeDep': {
      if (!target) return err('E_UNKNOWN_TASK', { task: op.task });
      target.deps = target.deps.filter((d) => d !== op.dep);
      return null;
    }
    case 'addTask': {
      if (tasks.has(op.task)) return err('E_EXISTS', { task: op.task });
      tasks.set(op.task, normalizeTask({ id: op.task, ...op }));
      return null;
    }
    case 'removeTask': {
      if (!target) return err('E_UNKNOWN_TASK', { task: op.task });
      for (const [id, task] of tasks) {
        if (id !== op.task && task.deps.includes(op.task)) {
          return err('E_HAS_DEPENDENTS', { task: op.task, dependent: id });
        }
      }
      tasks.delete(op.task);
      return null;
    }
    default:
      return err('E_UNKNOWN_OP', { op: op.type });
  }
}

export class Store {
  constructor() {
    this.tasks = new Map();
  }

  // Replace the whole graph and compute every result hash from scratch.
  loadTasks(taskList) {
    const working = new Map();
    for (const raw of taskList) {
      if (working.has(raw.id)) return err('E_EXISTS', { task: raw.id });
      working.set(raw.id, normalizeTask(raw));
    }
    for (const [id, task] of working) {
      for (const dep of task.deps) {
        if (!working.has(dep)) return err('E_UNKNOWN_TASK', { task: dep, referencedBy: id });
      }
    }
    const cycle = findCycle(working);
    if (cycle) return err('E_CYCLE', { cycle });
    for (const id of layeredOrder(working, new Set(working.keys()))) {
      const task = working.get(id);
      task.resultHash = hashResult(task, task.deps.map((d) => ({ id: d, hash: working.get(d).resultHash })));
    }
    this.tasks = working;
    return { ok: true };
  }

  snapshot() {
    return new Map([...this.tasks].map(([id, t]) => [id, { ...t, deps: [...t.deps] }]));
  }

  // Apply one transaction: a batch of ops plus a maxRecompute budget.
  // On any error the store is left untouched.
  applyTransaction(tx = {}) {
    const maxRecompute = tx.maxRecompute ?? Infinity;
    const ops = tx.ops ?? [];
    const working = this.snapshot();

    for (const op of ops) {
      const failure = applyOp(working, op);
      if (failure) return failure;
    }
    for (const [id, task] of working) {
      for (const dep of task.deps) {
        if (!working.has(dep)) return err('E_UNKNOWN_TASK', { task: dep, referencedBy: id });
      }
    }
    const cycle = findCycle(working);
    if (cycle) return err('E_CYCLE', { cycle });

    // Tasks whose declaration changed, plus their transitive dependents:
    // the invalidation closure.
    const changed = new Set();
    for (const [id, task] of working) {
      const old = this.tasks.get(id);
      if (
        !old ||
        old.inputHash !== task.inputHash ||
        old.moduleVersion !== task.moduleVersion ||
        !sameDeps(old.deps, task.deps)
      ) {
        changed.add(id);
      }
    }
    const dependents = buildDependents(working);
    const closure = new Set(changed);
    const queue = [...changed];
    while (queue.length > 0) {
      const id = queue.pop();
      for (const dependent of dependents.get(id)) {
        if (!closure.has(dependent)) {
          closure.add(dependent);
          queue.push(dependent);
        }
      }
    }
    const removed = [...this.tasks.keys()].filter((id) => !working.has(id));

    if (closure.size > maxRecompute) {
      return err('E_BUDGET', { required: closure.size, maxRecompute });
    }

    const order = layeredOrder(working, closure);
    const changes = [];
    const stopPoints = [];
    for (const id of order) {
      const task = working.get(id);
      const oldHash = this.tasks.get(id)?.resultHash ?? null;
      const newHash = hashResult(task, task.deps.map((d) => ({ id: d, hash: working.get(d).resultHash })));
      task.resultHash = newHash;
      changes.push({ id, oldHash, newHash });
      // A recomputed task whose hash is unchanged is a stop point: the
      // transaction's effect no longer propagates beyond it.
      if (oldHash === newHash) stopPoints.push(id);
    }
    for (const id of removed) {
      changes.push({ id, oldHash: this.tasks.get(id).resultHash, newHash: null });
    }

    this.tasks = working;
    return {
      ok: true,
      noop: closure.size === 0 && removed.length === 0,
      invalidated: order,
      changes,
      stopPoints,
    };
  }
}
