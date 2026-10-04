// Incremental scheduler with undo.
// Partition-level results are cached by a canonical key of the involved batch
// definitions + config; editing one batch only re-optimizes partitions whose
// key changed, so incremental results are identical to a full re-solve.
import { solveSchedule } from './solver.js';

export class Scheduler {
  constructor(config, opts = {}) {
    this.config = { ...config, alloyGroups: (config.alloyGroups || []).map((g) => [...g]) };
    this.opts = { ...opts };
    this.batches = new Map();
    this.cache = new Map();
    this.history = [];
    this.result = null;
  }

  _solve() {
    return solveSchedule(
      [...this.batches.values()].map((b) => structuredClone(b)),
      this.config,
      { ...this.opts, cache: this.cache }
    );
  }

  setBatches(list) {
    this.batches = new Map(list.map((b) => [b.id, structuredClone(b)]));
    this.history = [];
    this.result = this._solve();
    return this.result;
  }

  getBatch(id) {
    const b = this.batches.get(id);
    return b ? structuredClone(b) : undefined;
  }

  editBatch(id, patch) {
    if (!this.batches.has(id)) throw new Error(`unknown batch id: ${id}`);
    this.history.push({
      batches: new Map([...this.batches].map(([k, v]) => [k, structuredClone(v)])),
      result: this.result,
    });
    const next = { ...structuredClone(this.batches.get(id)), ...structuredClone(patch), id };
    this.batches.set(id, next);
    this.result = this._solve();
    return this.result;
  }

  undo() {
    const snap = this.history.pop();
    if (!snap) return this.result;
    this.batches = snap.batches;
    this.result = snap.result;
    return this.result;
  }
}
