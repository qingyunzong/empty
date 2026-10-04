import { SchedulerError, ERR_NOT_FOUND } from './errors.js';
import { prepareBatch } from './model.js';
import { solve } from './solver.js';

// 有状态调度器：维护批次集合，编辑后增量重排（按 id#version 缓存
// 同炉兼容判定与子集可行性，未受编辑影响的子集直接复用），undo 逐层恢复。
export class Scheduler {
  constructor(config = {}) {
    this.config = { grid: 1, nodeLimit: 200000, maxSolutions: 50, ...config };
    this._batches = new Map();
    this._versions = new Map();
    this._history = [];
    this._cache = { runCompat: new Map(), feas: new Map() };
    this._result = null;
    this._dirty = true;
  }

  _snapshot() {
    this._history.push({
      batches: structuredClone([...this._batches.entries()]),
      versions: new Map(this._versions),
      result: this._result === null ? null : structuredClone(this._result),
      dirty: this._dirty,
    });
  }

  addBatch(raw) {
    prepareBatch(raw); // 校验失败抛 SchedulerError，不改变状态
    this._snapshot();
    this._batches.set(raw.id, structuredClone(raw));
    this._versions.set(raw.id, (this._versions.get(raw.id) ?? 0) + 1);
    this._dirty = true;
    return raw.id;
  }

  editBatch(id, patch) {
    if (!this._batches.has(id)) {
      throw new SchedulerError(ERR_NOT_FOUND, `批次 ${id} 不存在`);
    }
    const merged = { ...structuredClone(this._batches.get(id)), ...patch, id };
    prepareBatch(merged);
    this._snapshot();
    this._batches.set(id, merged);
    this._versions.set(id, this._versions.get(id) + 1);
    this._dirty = true;
  }

  removeBatch(id) {
    if (!this._batches.has(id)) {
      throw new SchedulerError(ERR_NOT_FOUND, `批次 ${id} 不存在`);
    }
    this._snapshot();
    this._batches.delete(id);
    this._dirty = true;
  }

  undo() {
    const s = this._history.pop();
    if (!s) return false;
    this._batches = new Map(s.batches);
    this._versions = new Map(s.versions);
    this._result = s.result;
    this._dirty = s.dirty;
    return true;
  }

  listBatches() {
    return structuredClone([...this._batches.values()]);
  }

  // 增量重排：缓存键含批次版本号，编辑过的批次所属子集自动失效重算，
  // 其余子集复用缓存；结果与全量重算一致。
  resolve() {
    if (this._dirty || this._result === null) {
      const raws = [...this._batches.values()].map((r) => ({
        ...r,
        _version: this._versions.get(r.id),
      }));
      this._result = solve(raws, this.config, this._cache);
      this._dirty = false;
    }
    return this._result;
  }
}
