// Incremental scheduler with undo/redo.
//
// Holds a normalized instance plus a phase-1 DP cache shared across solves.
// Phase 1 (makespan/energy subset DP) is independent of due dates, so a
// due-only edit reuses every cached subproblem; edits to work/energy/mold
// invalidate exactly the cache entries whose remaining-set contains the edited
// job ("only recompute the affected subproblems"). Phase 2 (tardiness + tie
// enumeration) re-runs on every edit.
//
// undo()/redo() restore the instance AND the solver result of any earlier edit
// point via snapshot stacks.

import { normalizeInstance } from './schema.mjs';
import { solveNormalized } from './solver.mjs';

const EDITABLE_FIELDS = ['due', 'work', 'energy', 'mold'];

export class Scheduler {
  constructor(rawInstance, opts = {}) {
    const v = normalizeInstance(rawInstance);
    if (!v.ok) throw new Error(`ERR_SCHEMA: ${v.error}`);
    this.norm = v.instance;
    this.opts = opts;
    this.cache = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.lastStats = null;
    this.result = this.#solve();
  }

  #solve() {
    const stats = { p1Computed: 0, p1Hits: 0, p2Nodes: 0 };
    const result = solveNormalized(this.norm, { ...this.opts, cache: this.cache, stats });
    this.lastStats = stats;
    return result;
  }

  #snapshot() {
    return {
      jobs: structuredClone(this.norm.jobs),
      energyBudget: this.norm.energyBudget,
      result: this.result,
    };
  }

  // Drop every cached subproblem whose remaining-set contains job `index`.
  #invalidateJob(index) {
    const stride = this.norm.molds.length + 1;
    const bit = 1 << index;
    for (const key of this.cache.keys()) {
      if (Math.floor(key / stride) & bit) this.cache.delete(key);
    }
  }

  #jobIndex(idOrIndex) {
    if (typeof idOrIndex === 'number' && this.norm.jobs[idOrIndex]?.id === idOrIndex) {
      return idOrIndex;
    }
    const i = this.norm.jobs.findIndex((j) => j.id === idOrIndex);
    if (i < 0) throw new Error(`unknown job: ${JSON.stringify(idOrIndex)}`);
    return i;
  }

  editJob(idOrIndex, patch) {
    const index = this.#jobIndex(idOrIndex);
    for (const key of Object.keys(patch)) {
      if (!EDITABLE_FIELDS.includes(key)) throw new Error(`cannot edit field: ${key}`);
    }
    if (patch.mold !== undefined && !this.norm.molds.includes(String(patch.mold))) {
      throw new Error(`unknown mold: ${JSON.stringify(patch.mold)}`);
    }
    this.undoStack.push(this.#snapshot());
    this.redoStack.length = 0;
    const job = this.norm.jobs[index];
    for (const key of EDITABLE_FIELDS) {
      if (patch[key] === undefined) continue;
      job[key] = key === 'mold' ? String(patch[key]) : patch[key];
    }
    this.#invalidateJob(index);
    this.result = this.#solve();
    return this.result;
  }

  setEnergyBudget(budget) {
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
      throw new Error('energyBudget must be a non-negative finite number');
    }
    this.undoStack.push(this.#snapshot());
    this.redoStack.length = 0;
    this.norm.energyBudget = budget; // phase-1 cache is budget-independent
    this.result = this.#solve();
    return this.result;
  }

  undo() {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push(this.#snapshot());
    this.#restore(this.undoStack.pop());
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push(this.#snapshot());
    this.#restore(this.redoStack.pop());
    return true;
  }

  #restore(snap) {
    // Invalidate cache entries for jobs whose parameters actually changed.
    for (let i = 0; i < snap.jobs.length; i++) {
      if (JSON.stringify(snap.jobs[i]) !== JSON.stringify(this.norm.jobs[i])) {
        this.#invalidateJob(i);
      }
    }
    this.norm.jobs = structuredClone(snap.jobs);
    this.norm.energyBudget = snap.energyBudget;
    this.result = snap.result;
  }
}
