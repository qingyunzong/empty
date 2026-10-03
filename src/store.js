import { parseRational, cmp, fmt } from './rational.js';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export class MaintenanceStore {
  constructor() {
    this.tasks = new Map();
    this.history = [];
    this.redoStack = [];
  }

  _validate(list) {
    if (!Array.isArray(list)) throw new StoreError('E_BATCH', 'tasks must be an array');
    const parsed = new Map();
    for (const t of list) {
      if (!t || typeof t.id !== 'string' || t.id.length === 0) {
        throw new StoreError('E_ID', 'task id must be a non-empty string');
      }
      if (parsed.has(t.id) || this.tasks.has(t.id)) {
        throw new StoreError('E_DUPLICATE', `duplicate task id: ${t.id}`);
      }
      if (!Array.isArray(t.cost) || t.cost.length !== 2 ||
          !Array.isArray(t.duration) || t.duration.length !== 2) {
        throw new StoreError('E_INTERVAL', `task ${t.id}: cost/duration must be [low, high]`);
      }
      const priority = parseRational(t.priority);
      const cl = parseRational(t.cost[0]);
      const ch = parseRational(t.cost[1]);
      const dl = parseRational(t.duration[0]);
      const dh = parseRational(t.duration[1]);
      if (cmp(cl, ch) > 0) throw new StoreError('E_INTERVAL', `task ${t.id}: cost low > high`);
      if (cmp(dl, dh) > 0) throw new StoreError('E_INTERVAL', `task ${t.id}: duration low > high`);
      const requires = t.requires ?? [];
      if (!Array.isArray(requires) || requires.some((r) => typeof r !== 'string')) {
        throw new StoreError('E_PRECEDENCE', `task ${t.id}: requires must be an array of task ids`);
      }
      parsed.set(t.id, { priority, cl, ch, dl, dh, requires: [...new Set(requires)] });
    }
    for (const [id, t] of parsed) {
      for (const r of t.requires) {
        if (!parsed.has(r) && !this.tasks.has(r)) {
          throw new StoreError('E_UNKNOWN_TASK', `task ${id} requires unknown task ${r}`);
        }
      }
    }
    const reqOf = (id) =>
      (parsed.get(id) ?? this.tasks.get(id)).requires;
    const state = new Map();
    const visit = (u, path) => {
      state.set(u, 1);
      for (const v of reqOf(u)) {
        if (state.get(v) === 1) {
          throw new StoreError('E_CYCLE', `cyclic precedence: ${[...path, u, v].join(' -> ')}`);
        }
        if (!state.get(v)) visit(v, [...path, u]);
      }
      state.set(u, 2);
    };
    for (const id of [...this.tasks.keys(), ...parsed.keys()]) {
      if (!state.get(id)) visit(id, []);
    }
    return parsed;
  }

  _commit(parsed) {
    for (const [id, t] of parsed) this.tasks.set(id, t);
  }

  importBatch(list) {
    const parsed = this._validate(list);
    this._commit(parsed);
    this.history.push(parsed);
    this.redoStack.length = 0;
    return { ok: true, imported: [...parsed.keys()] };
  }

  undo() {
    const batch = this.history.pop();
    if (!batch) return { ok: false, error: 'E_NOTHING_TO_UNDO' };
    for (const id of batch.keys()) this.tasks.delete(id);
    this.redoStack.push(batch);
    return { ok: true, undone: [...batch.keys()] };
  }

  redo() {
    const batch = this.redoStack.pop();
    if (!batch) return { ok: false, error: 'E_NOTHING_TO_REDO' };
    try {
      this._validate([...batch].map(([id, t]) => ({
        id,
        priority: fmt(t.priority),
        cost: [fmt(t.cl), fmt(t.ch)],
        duration: [fmt(t.dl), fmt(t.dh)],
        requires: [...t.requires],
      })));
    } catch (e) {
      return { ok: false, error: e.code ?? 'E_INTERNAL', message: e.message };
    }
    this._commit(batch);
    this.history.push(batch);
    return { ok: true, redone: [...batch.keys()] };
  }

  snapshot() {
    return {
      tasks: [...this.tasks].map(([id, t]) => ({
        id,
        priority: fmt(t.priority),
        cost: [fmt(t.cl), fmt(t.ch)],
        duration: [fmt(t.dl), fmt(t.dh)],
        requires: [...t.requires],
      })),
      canUndo: this.history.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }
}
