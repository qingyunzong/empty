import { ReplanError } from './errors.js';

export const DEFAULT_MAX_RETRIES = 2;

function numOrNull(v, field, id) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || Number.isNaN(v) || v < 0) {
    throw new ReplanError('E_INPUT', `task "${id}": field "${field}" must be a non-negative number or null`);
  }
  return v;
}

export function parseDag(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.tasks)) {
    throw new ReplanError('E_INPUT', 'dag file must contain a "tasks" array');
  }
  const tasks = new Map();
  for (const raw of obj.tasks) {
    if (!raw || typeof raw.id !== 'string' || raw.id.length === 0) {
      throw new ReplanError('E_INPUT', 'every task needs a non-empty string "id"');
    }
    const id = raw.id;
    if (tasks.has(id)) throw new ReplanError('E_INPUT', `duplicate task id: "${id}"`);
    const deps = raw.deps === undefined ? [] : raw.deps;
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) {
      throw new ReplanError('E_INPUT', `task "${id}": "deps" must be an array of task ids`);
    }
    if (new Set(deps).size !== deps.length) {
      throw new ReplanError('E_INPUT', `task "${id}": duplicate entries in "deps"`);
    }
    const failRate = raw.failRate === undefined ? null : raw.failRate;
    if (failRate !== null && (typeof failRate !== 'number' || failRate < 0 || failRate > 1)) {
      throw new ReplanError('E_INPUT', `task "${id}": "failRate" must be in [0,1] or null`);
    }
    const maxRetries = raw.maxRetries === undefined ? DEFAULT_MAX_RETRIES : raw.maxRetries;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new ReplanError('E_INPUT', `task "${id}": "maxRetries" must be a non-negative integer`);
    }
    const value = raw.value === undefined ? 1 : raw.value;
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
      throw new ReplanError('E_INPUT', `task "${id}": "value" must be a non-negative number`);
    }
    tasks.set(id, {
      id,
      deps: [...deps],
      cpu: numOrNull(raw.cpu, 'cpu', id),
      mem: numOrNull(raw.mem, 'mem', id),
      wall: numOrNull(raw.wall, 'wall', id),
      failRate,
      maxRetries,
      value,
    });
  }
  for (const t of tasks.values()) {
    for (const d of t.deps) {
      if (!tasks.has(d)) {
        throw new ReplanError('E_INPUT', `task "${t.id}" depends on unknown task "${d}"`);
      }
    }
  }
  const cycle = findCycle(tasks);
  if (cycle) {
    throw new ReplanError('E_CYCLE', `dependency cycle detected: ${cycle.join(' -> ')}`, { cycle });
  }
  const ids = [...tasks.keys()].sort();
  const dependents = new Map(ids.map((id) => [id, []]));
  for (const t of tasks.values()) {
    for (const d of t.deps) dependents.get(d).push(t.id);
  }
  for (const list of dependents.values()) list.sort();

  const ancestorCache = new Map();
  const ancestors = (id) => {
    if (ancestorCache.has(id)) return ancestorCache.get(id);
    const acc = new Set();
    const stack = [...tasks.get(id).deps];
    while (stack.length) {
      const cur = stack.pop();
      if (acc.has(cur)) continue;
      acc.add(cur);
      for (const d of tasks.get(cur).deps) stack.push(d);
    }
    const out = [...acc].sort();
    ancestorCache.set(id, out);
    return out;
  };

  return { tasks, ids, dependents, ancestors };
}

function findCycle(tasks) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...tasks.keys()].map((id) => [id, WHITE]));
  const stack = [];
  for (const start of tasks.keys()) {
    if (color.get(start) !== WHITE) continue;
    const frames = [{ id: start, next: 0 }];
    color.set(start, GRAY);
    stack.push(start);
    while (frames.length) {
      const f = frames[frames.length - 1];
      const deps = tasks.get(f.id).deps;
      if (f.next < deps.length) {
        const d = deps[f.next++];
        const c = color.get(d);
        if (c === GRAY) {
          const at = stack.indexOf(d);
          return [...stack.slice(at), d];
        }
        if (c === WHITE) {
          color.set(d, GRAY);
          stack.push(d);
          frames.push({ id: d, next: 0 });
        }
      } else {
        frames.pop();
        stack.pop();
        color.set(f.id, BLACK);
      }
    }
  }
  return null;
}

export function parseBudget(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ReplanError('E_INPUT', 'budget file must be a JSON object like {"cpu":N,"mem":N,"wall":N}');
  }
  const out = {};
  for (const d of ['cpu', 'mem', 'wall']) {
    const v = obj[d];
    if (v === undefined || v === null) { out[d] = null; continue; }
    if (typeof v !== 'number' || Number.isNaN(v) || v < 0) {
      throw new ReplanError('E_INPUT', `budget "${d}" must be a non-negative number or null`);
    }
    out[d] = v;
  }
  return out;
}

// Incremental ready set: indegrees are maintained as tasks complete;
// newly-ready tasks surface in O(dependents) without rescanning the graph.
export class ReadySet {
  constructor(dag, subset = null) {
    this.dag = dag;
    const ids = subset ? [...subset] : dag.ids;
    this.inSet = new Set(ids);
    this.remaining = new Map();
    this.ready = [];
    for (const id of ids) {
      const t = dag.tasks.get(id);
      if (!t) throw new ReplanError('E_INPUT', `unknown task in ready subset: "${id}"`);
      const cnt = t.deps.filter((d) => this.inSet.has(d)).length;
      this.remaining.set(id, cnt);
      if (cnt === 0) this.insert(id);
    }
  }
  insert(id) {
    let lo = 0, hi = this.ready.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ready[mid] < id) lo = mid + 1; else hi = mid;
    }
    this.ready.splice(lo, 0, id);
  }
  complete(id) {
    const at = this.ready.indexOf(id);
    if (at !== -1) this.ready.splice(at, 1);
    const newly = [];
    for (const dep of this.dag.dependents.get(id) ?? []) {
      if (!this.inSet.has(dep)) continue;
      const r = this.remaining.get(dep) - 1;
      this.remaining.set(dep, r);
      if (r === 0) {
        this.insert(dep);
        newly.push(dep);
      }
    }
    return newly;
  }
  next() {
    return this.ready.length ? this.ready.shift() : null;
  }
  get size() {
    return this.ready.length;
  }
}
