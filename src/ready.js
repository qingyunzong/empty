import { ReplanError } from './errors.js';

// Incremental ready set over a fixed task id collection. In-degree counters
// are maintained as tasks complete; the ready list stays sorted so that
// peek() is a deterministic lexicographic choice.
export class ReadySet {
  constructor(tasks, ids, done = new Set()) {
    this.tasks = tasks;
    this.done = new Set(done);
    this.remaining = new Set();
    this.indeg = new Map();
    this.ready = [];
    this.dependents = new Map();
    for (const id of tasks.keys()) this.dependents.set(id, []);
    for (const t of tasks.values()) {
      for (const d of t.deps) this.dependents.get(d).push(t.id);
    }
    for (const id of ids) {
      if (this.done.has(id)) continue;
      if (!tasks.has(id)) throw new ReplanError('E_UNKNOWN', `ready: unknown task "${id}"`);
      this.remaining.add(id);
    }
    for (const id of this.remaining) {
      let c = 0;
      for (const d of tasks.get(id).deps) {
        if (this.remaining.has(d)) c++;
      }
      this.indeg.set(id, c);
      if (c === 0) this.#insert(id);
    }
  }

  #insert(id) {
    const i = this.ready.findIndex((x) => x > id);
    if (i === -1) this.ready.push(id);
    else this.ready.splice(i, 0, id);
  }

  get size() {
    return this.remaining.size;
  }

  peek() {
    return this.ready[0];
  }

  readyIds() {
    return [...this.ready];
  }

  complete(id) {
    if (!this.remaining.has(id)) {
      throw new ReplanError('E_USAGE', `ready: task "${id}" is not pending`);
    }
    this.remaining.delete(id);
    this.done.add(id);
    const i = this.ready.indexOf(id);
    if (i !== -1) this.ready.splice(i, 1);
    for (const dep of this.dependents.get(id)) {
      if (!this.remaining.has(dep)) continue;
      const c = this.indeg.get(dep) - 1;
      this.indeg.set(dep, c);
      if (c === 0) this.#insert(dep);
    }
  }

  // Permanently drop a task (e.g. retries exhausted). Dependents stay
  // blocked and will never become ready.
  drop(id) {
    if (!this.remaining.has(id)) return;
    this.remaining.delete(id);
    const i = this.ready.indexOf(id);
    if (i !== -1) this.ready.splice(i, 1);
  }
}
