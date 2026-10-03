export class SchedulerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export const E_BUDGET = 'E_BUDGET';
export const E_CONFLICT = 'E_CONFLICT';
export const E_EMPTY = 'E_EMPTY';

function shareResource(a, b) {
  return a.resources.some((r) => b.resources.includes(r));
}

function timeOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

export class Scheduler {
  constructor({ budget = Infinity } = {}) {
    this.budget = budget;
    this.tasks = new Map();
    this.undoStack = []; // applied change records, latest on top
    this.redoStack = [];
  }

  addTask({ id, resources, start, end, deadline = end }) {
    if (this.tasks.has(id)) throw new SchedulerError(E_CONFLICT, `duplicate task ${id}`);
    if (!(end > start)) throw new SchedulerError(E_CONFLICT, `task ${id} has empty interval`);
    this.tasks.set(id, { id, resources: [...resources], start, end, deadline });
    return this.tasks.get(id);
  }

  getTask(id) {
    const t = this.tasks.get(id);
    if (!t) throw new SchedulerError(E_EMPTY, `unknown task ${id}`);
    return t;
  }

  delayOf(task) {
    return Math.max(0, task.end - task.deadline);
  }

  // All conflicting pairs (shared resource + overlapping interval),
  // optionally restricted to a subset of task ids. Deterministic order.
  conflicts(taskIds = null) {
    const ids = taskIds ? [...taskIds].sort() : [...this.tasks.keys()].sort();
    const pairs = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = this.tasks.get(ids[i]);
        const b = this.tasks.get(ids[j]);
        if (shareResource(a, b) && timeOverlap(a, b)) {
          pairs.push([a.id, b.id]);
        }
      }
    }
    return pairs;
  }

  // Tasks sharing at least one resource with taskId (taskId included).
  affectedSet(taskId) {
    const t = this.getTask(taskId);
    const out = new Set([taskId]);
    for (const [id, other] of this.tasks) {
      if (id !== taskId && shareResource(t, other)) out.add(id);
    }
    return out;
  }

  affectedCost(taskId) {
    let sum = 0;
    for (const id of this.affectedSet(taskId)) sum += this.delayOf(this.tasks.get(id));
    return sum;
  }

  _applyRecord(rec) {
    const t = this.tasks.get(rec.taskId);
    t.start = rec.newStart;
    t.end = rec.newEnd;
  }

  _revertRecord(rec) {
    const t = this.tasks.get(rec.taskId);
    t.start = rec.prevStart;
    t.end = rec.prevEnd;
  }

  _checkBudget(taskId) {
    const cost = this.affectedCost(taskId);
    if (cost > this.budget) {
      throw new SchedulerError(E_BUDGET, `affected-set delay ${cost} exceeds budget ${this.budget}`);
    }
  }

  _result(rec) {
    const affected = [...this.affectedSet(rec.taskId)].sort();
    return { record: rec, affected, conflicts: this.conflicts(affected) };
  }

  // change: shift a task in time. Budget is enforced on the affected set;
  // on violation the state is left untouched.
  applyChange({ taskId, shift }) {
    const t = this.getTask(taskId);
    const rec = {
      taskId,
      prevStart: t.start,
      prevEnd: t.end,
      newStart: t.start + shift,
      newEnd: t.end + shift,
    };
    this._applyRecord(rec);
    try {
      this._checkBudget(taskId);
    } catch (e) {
      this._revertRecord(rec);
      throw e;
    }
    this.undoStack.push(rec);
    this.redoStack.length = 0;
    return this._result(rec);
  }

  // Roll back one layer: recompute the affected task set and its delay
  // cost; if it exceeds the budget the rollback fails and nothing changes.
  undo() {
    if (this.undoStack.length === 0) throw new SchedulerError(E_EMPTY, 'nothing to undo');
    const rec = this.undoStack[this.undoStack.length - 1];
    this._revertRecord(rec);
    try {
      this._checkBudget(rec.taskId);
    } catch (e) {
      this._applyRecord(rec); // state unchanged
      throw e;
    }
    this.undoStack.pop();
    this.redoStack.push(rec);
    return this._result(rec);
  }

  redo() {
    if (this.redoStack.length === 0) throw new SchedulerError(E_EMPTY, 'nothing to redo');
    const rec = this.redoStack[this.redoStack.length - 1];
    this._applyRecord(rec);
    try {
      this._checkBudget(rec.taskId);
    } catch (e) {
      this._revertRecord(rec);
      throw e;
    }
    this.redoStack.pop();
    this.undoStack.push(rec);
    return this._result(rec);
  }

  // Best placement for a new task. Candidates: every resource option x
  // every integer start in [windowStart, windowEnd - duration].
  // Ranking: fewest conflicts, then fewest resources, then least delay,
  // then lexicographic (resource list, then start).
  findBestPlacement({ duration, resourceOptions, windowStart, windowEnd, deadline = Infinity }) {
    let best = null;
    let bestKey = null;
    for (const resources of resourceOptions) {
      for (let start = windowStart; start + duration <= windowEnd; start++) {
        const cand = { id: '', resources, start, end: start + duration, deadline };
        let nConflicts = 0;
        for (const t of this.tasks.values()) {
          if (shareResource(cand, t) && timeOverlap(cand, t)) nConflicts++;
        }
        const delay = Math.max(0, cand.end - deadline);
        const key = [nConflicts, resources.length, delay, resources.join(','), start];
        if (
          bestKey === null ||
          key[0] < bestKey[0] ||
          (key[0] === bestKey[0] &&
            (key[1] < bestKey[1] ||
              (key[1] === bestKey[1] &&
                (key[2] < bestKey[2] ||
                  (key[2] === bestKey[2] &&
                    (key[3] < bestKey[3] ||
                      (key[3] === bestKey[3] && key[4] < bestKey[4])))))))
        ) {
          bestKey = key;
          best = { resources: [...resources], start, end: start + duration, conflicts: nConflicts, delay };
        }
      }
    }
    if (best === null) throw new SchedulerError(E_EMPTY, 'no feasible placement in window');
    return best;
  }
}
