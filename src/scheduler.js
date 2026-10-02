import { validateInstance } from './validate.js';
import { solveCanonical, buildUnsatCertificate } from './solver.js';

const deepCopy = (v) => JSON.parse(JSON.stringify(v));

/**
 * Stateful scheduler: holds a canonical instance, supports job edits with
 * an undo/redo command stack (restorable to any edit point), and re-solves
 * incrementally — only DP states whose mask contains a changed job are
 * recomputed; all other subproblems are reused.
 */
export class Scheduler {
  constructor(rawInstance, options = {}) {
    this.options = options;
    this.instance = validateInstance(rawInstance);
    this.undoStack = [];
    this.redoStack = [];
    this.lastRun = null; // { snapshot, result }
  }

  editJob(id, patch) {
    const idx = this.instance.jobs.findIndex((j) => j.id === id);
    if (idx < 0) throw new Error(`unknown job id: ${id}`);
    const before = { ...this.instance.jobs[idx] };
    const after = { ...before };
    for (const key of ['due', 'work', 'energy']) {
      if (key in patch) {
        const v = patch[key];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          throw new Error(`invalid ${key}: must be a non-negative finite number`);
        }
        after[key] = v;
      }
    }
    if ('mold' in patch) {
      const mold = String(patch.mold);
      if (!this.instance.molds.includes(mold)) throw new Error(`unknown mold: ${mold}`);
      after.mold = mold;
      after.moldIdx = this.instance.molds.indexOf(mold);
    }
    this._commit({ kind: 'editJob', id, before, after });
  }

  _commit(cmd) {
    this._applyEdit(cmd.after);
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
  }

  _applyEdit(jobState) {
    const idx = this.instance.jobs.findIndex((j) => j.id === jobState.id);
    this.instance.jobs[idx] = { ...jobState };
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    this._applyEdit(cmd.before);
    this.redoStack.push(cmd);
    return true;
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    this._applyEdit(cmd.after);
    this.undoStack.push(cmd);
    return true;
  }

  /** Diff current instance against the snapshot of the last solve. */
  _diff() {
    const prev = this.lastRun.snapshot;
    const cur = this.instance;
    if (prev.energyBudget !== cur.energyBudget) return null;
    if (JSON.stringify(prev.setup) !== JSON.stringify(cur.setup)) return null;
    if (JSON.stringify(prev.molds) !== JSON.stringify(cur.molds)) return null;
    if (prev.jobs.length !== cur.jobs.length) return null;
    const changed = [];
    for (let i = 0; i < cur.jobs.length; i++) {
      const a = prev.jobs[i];
      const b = cur.jobs[i];
      if (a.id !== b.id) return null;
      if (a.due !== b.due || a.work !== b.work || a.energy !== b.energy || a.moldIdx !== b.moldIdx) {
        changed.push(i);
      }
    }
    return changed;
  }

  solve(extraOptions = {}) {
    const opts = { ...this.options, ...extraOptions };
    let reuse = null;
    let incremental = false;
    let cached = false;

    if (this.lastRun) {
      const changed = this._diff();
      if (changed !== null) {
        if (changed.length === 0) {
          cached = true;
        } else {
          let changedJobsMask = 0;
          for (const i of changed) changedJobsMask |= 1 << i;
          reuse = {
            states: this.lastRun.result.table.states,
            size: this.lastRun.result.table.size,
            changedJobsMask,
          };
          incremental = true;
        }
      }
    }

    let result;
    if (cached) {
      result = this.lastRun.result;
    } else {
      result = solveCanonical(this.instance, { ...opts, reuse });
      if (result.status === 'UNSAT') {
        result.certificate = buildUnsatCertificate(this.instance, result);
      }
      this.lastRun = { snapshot: deepCopy(this.instance), result };
    }
    return { ...result, stats: { ...result.stats, incremental, cached } };
  }
}
