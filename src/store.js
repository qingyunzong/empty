// Transactional task store with undo/redo.
// importBatch validates the whole batch before mutating anything, so any
// failure (bad rational, cl>ch, duplicate id, unknown precedent, cycle)
// leaves the store untouched: the batch is rolled back atomically.

import { Rational } from './rational.js';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function normalizeTask(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StoreError('E_TASK', 'task must be an object');
  }
  const id = raw.id;
  if (!['string', 'number'].includes(typeof id) || id === '') {
    throw new StoreError('E_TASK', 'task id must be a non-empty string or number');
  }
  const cost = raw.cost ?? [raw.cl, raw.ch];
  const duration = raw.duration ?? [raw.dl, raw.dh];
  if (!Array.isArray(cost) || cost.length !== 2) {
    throw new StoreError('E_INTERVAL', `task ${id}: cost must be [cl, ch]`);
  }
  if (!Array.isArray(duration) || duration.length !== 2) {
    throw new StoreError('E_INTERVAL', `task ${id}: duration must be [dl, dh]`);
  }
  // Rational.parse throws RationalError with code E_RATIONAL on bad input.
  const priority = Rational.parse(raw.priority ?? 0);
  const cl = Rational.parse(cost[0]);
  const ch = Rational.parse(cost[1]);
  const dl = Rational.parse(duration[0]);
  const dh = Rational.parse(duration[1]);
  if (cl.gt(ch)) {
    throw new StoreError('E_INTERVAL', `task ${id}: cost lower bound exceeds upper bound`);
  }
  if (dl.gt(dh)) {
    throw new StoreError('E_INTERVAL', `task ${id}: duration lower bound exceeds upper bound`);
  }
  const deps = raw.precedence ?? raw.deps ?? [];
  if (!Array.isArray(deps)) {
    throw new StoreError('E_TASK', `task ${id}: precedence must be an array of ids`);
  }
  return { id, priority, cl, ch, dl, dh, deps: [...deps] };
}

export class Store {
  #tasks = new Map();
  #undo = [];
  #redo = [];

  get size() { return this.#tasks.size; }

  has(id) { return this.#tasks.has(id); }

  list() { return [...this.#tasks.values()].map((t) => ({ ...t, deps: [...t.deps] })); }

  importBatch(rawTasks) {
    if (!Array.isArray(rawTasks)) {
      throw new StoreError('E_TASK', 'import expects an array of tasks');
    }
    // Phase 1: validate everything without mutating state.
    const batch = rawTasks.map(normalizeTask);
    const seen = new Set();
    for (const t of batch) {
      if (seen.has(t.id) || this.#tasks.has(t.id)) {
        throw new StoreError('E_DUPLICATE', `duplicate task id: ${t.id}`);
      }
      seen.add(t.id);
    }
    const known = new Set([...this.#tasks.keys(), ...seen]);
    for (const t of batch) {
      for (const dep of t.deps) {
        if (!known.has(dep)) {
          throw new StoreError('E_UNKNOWN_PRECEDENT', `task ${t.id}: unknown precedent ${dep}`);
        }
      }
    }
    // Cycle check over existing graph plus the new batch.
    const graph = new Map();
    for (const t of this.#tasks.values()) graph.set(t.id, t.deps);
    for (const t of batch) graph.set(t.id, t.deps);
    const state = new Map(); // 0=unvisited, 1=in stack, 2=done
    const visit = (id) => {
      const s = state.get(id) ?? 0;
      if (s === 1) throw new StoreError('E_CYCLE', `precedence cycle involving task ${id}`);
      if (s === 2) return;
      state.set(id, 1);
      for (const dep of graph.get(id) ?? []) visit(dep);
      state.set(id, 2);
    };
    for (const id of graph.keys()) visit(id);

    // Phase 2: commit.
    for (const t of batch) this.#tasks.set(t.id, t);
    this.#undo.push({ type: 'import', tasks: batch });
    this.#redo.length = 0;
    return batch.length;
  }

  undo() {
    const entry = this.#undo.pop();
    if (!entry) throw new StoreError('E_HISTORY', 'nothing to undo');
    for (const t of entry.tasks) this.#tasks.delete(t.id);
    this.#redo.push(entry);
    return entry.tasks.length;
  }

  redo() {
    const entry = this.#redo.pop();
    if (!entry) throw new StoreError('E_HISTORY', 'nothing to redo');
    for (const t of entry.tasks) this.#tasks.set(t.id, t);
    this.#undo.push(entry);
    return entry.tasks.length;
  }
}
