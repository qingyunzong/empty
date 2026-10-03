import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PlannerError, E_LIMIT, E_STATE } from './errors.js';

// Job store with audit trail. Voided jobs stay in the store (and in the
// audit log) but are filtered from selection candidates immediately.
export class JobStore {
  constructor() {
    this.jobs = new Map(); // id -> job
    this.audit = []; // {seq, op, jobId, at}
  }

  #log(op, jobId) {
    this.audit.push({ seq: this.audit.length + 1, op, jobId, at: new Date().toISOString() });
  }

  #get(id, op) {
    const job = this.jobs.get(id);
    if (!job) throw new PlannerError(E_STATE, `${op}: job "${id}" does not exist`);
    return job;
  }

  add(job) {
    const { id, description, material, equipment, cost, overdue } = job ?? {};
    for (const [name, v] of [['id', id], ['description', description], ['material', material], ['equipment', equipment]]) {
      if (typeof v !== 'string' || v.length === 0) {
        throw new PlannerError(E_LIMIT, `add: field "${name}" must be a non-empty string`);
      }
    }
    if (!Number.isInteger(cost) || cost < 0) {
      throw new PlannerError(E_LIMIT, `add: cost must be a non-negative integer, got ${cost}`);
    }
    if (!Number.isInteger(overdue) || overdue < 0) {
      throw new PlannerError(E_LIMIT, `add: overdue must be a non-negative integer, got ${overdue}`);
    }
    if (this.jobs.has(id)) {
      throw new PlannerError(E_STATE, `add: job "${id}" already exists`);
    }
    this.jobs.set(id, { id, description, material, equipment, cost, overdue, voided: false });
    this.#log('add', id);
  }

  void(id) {
    const job = this.#get(id, 'void');
    if (job.voided) throw new PlannerError(E_STATE, `void: job "${id}" is already voided`);
    job.voided = true;
    this.#log('void', id);
  }

  restore(id) {
    const job = this.#get(id, 'restore');
    if (!job.voided) throw new PlannerError(E_STATE, `restore: job "${id}" is not voided`);
    job.voided = false;
    this.#log('restore', id);
  }

  active() {
    return [...this.jobs.values()].filter((j) => !j.voided);
  }

  toJSON() {
    return { jobs: [...this.jobs.values()], audit: this.audit };
  }

  static fromJSON(data) {
    const store = new JobStore();
    for (const job of data.jobs ?? []) store.jobs.set(job.id, { ...job });
    store.audit = [...(data.audit ?? [])];
    return store;
  }
}

export function loadStore(path) {
  if (!existsSync(path)) return new JobStore();
  return JobStore.fromJSON(JSON.parse(readFileSync(path, 'utf8')));
}

export function saveStore(path, store) {
  writeFileSync(path, JSON.stringify(store.toJSON(), null, 2) + '\n');
}
