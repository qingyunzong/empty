import { SearchIndex } from './search.js';
import { tokenize } from './tokenize.js';
import {
  PlannerError,
  applyOp,
  invertOp,
  validateTransition,
  computeConflicts,
  bestPlacement,
} from './scheduler.js';

function windowForOp(tasks, op) {
  const spans = [];
  const push = (t) => { if (t) spans.push([t.start, t.end]); };
  switch (op.type) {
    case 'add': push(op.task); break;
    case 'remove': push(tasks[op.taskId]); break;
    case 'shift': {
      const t = tasks[op.taskId];
      if (t) spans.push([t.start, t.end], [t.start + op.delta, t.end + op.delta]);
      break;
    }
    default: break;
  }
  if (!spans.length) return null;
  return {
    start: Math.min(...spans.map((s) => s[0])),
    end: Math.max(...spans.map((s) => s[1])),
  };
}

export class Planner {
  constructor(state = null) {
    this.state = state ?? { tasks: {}, applied: [], undone: [], nextChangeId: 1 };
    this.index = new SearchIndex();
    this.rebuildIndex();
  }

  rebuildIndex() {
    this.index = new SearchIndex();
    for (const change of this.state.applied) {
      if (change.note != null) this.index.add(change.id, change.note);
    }
  }

  // note: change-log text (indexed); op: task mutation or {type:'deleteNote'}.
  applyChange(note, op) {
    if (op.type === 'deleteNote') {
      const target = this.state.applied.find((c) => c.id === op.changeId);
      if (!target || target.note == null) {
        throw new PlannerError('E_EMPTY', `no note on change ${op.changeId}`);
      }
      const change = {
        id: this.state.nextChangeId++,
        note: note ?? null,
        op,
        window: null,
        deletedNote: target.note,
      };
      target.note = null;
      this.state.applied.push(change);
      this.state.undone = [];
      this.rebuildIndex();
      return change.id;
    }
    const after = applyOp(this.state.tasks, op);
    validateTransition(this.state.tasks, after, op);
    const change = {
      id: this.state.nextChangeId++,
      note: note ?? null,
      op,
      inverse: invertOp(this.state.tasks, op),
      window: windowForOp(this.state.tasks, op),
    };
    this.state.tasks = after;
    this.state.applied.push(change);
    this.state.undone = [];
    this.rebuildIndex();
    return change.id;
  }

  undo() {
    const change = this.state.applied[this.state.applied.length - 1];
    if (!change) throw new PlannerError('E_EMPTY', 'nothing to undo');
    if (change.op.type === 'deleteNote') {
      const target = this.state.applied.find((c) => c.id === change.op.changeId);
      target.note = change.deletedNote;
      this.state.applied.pop();
      this.state.undone.push(change);
      this.rebuildIndex();
      return change.id;
    }
    // Tentative rollback: recompute the affected task set and re-validate
    // budget/conflicts. On failure the state is left untouched.
    const after = applyOp(this.state.tasks, change.inverse);
    validateTransition(this.state.tasks, after, change.inverse);
    this.state.tasks = after;
    this.state.applied.pop();
    this.state.undone.push(change);
    this.rebuildIndex();
    return change.id;
  }

  redo() {
    const change = this.state.undone[this.state.undone.length - 1];
    if (!change) throw new PlannerError('E_EMPTY', 'nothing to redo');
    if (change.op.type === 'deleteNote') {
      const target = this.state.applied.find((c) => c.id === change.op.changeId);
      target.note = null;
      this.state.undone.pop();
      this.state.applied.push(change);
      this.rebuildIndex();
      return change.id;
    }
    const after = applyOp(this.state.tasks, change.op);
    validateTransition(this.state.tasks, after, change.op);
    this.state.tasks = after;
    this.state.undone.pop();
    this.state.applied.push(change);
    this.rebuildIndex();
    return change.id;
  }

  // Phrase (or proximity) query over change notes, optionally restricted to
  // changes whose task time window intersects [from, to].
  query(text, { near = null, from = null, to = null } = {}) {
    const terms = tokenize(text);
    const hits = this.index.search(terms, { near });
    const byId = new Map(this.state.applied.map((c) => [c.id, c]));
    return hits.filter((id) => {
      const change = byId.get(id);
      if (!change) return false;
      if (from === null && to === null) return true;
      if (!change.window) return false;
      const lo = from ?? -Infinity;
      const hi = to ?? Infinity;
      return change.window.start < hi && lo < change.window.end;
    });
  }

  conflicts() {
    return computeConflicts(this.state.tasks);
  }

  plan(spec, horizon) {
    return bestPlacement(this.state.tasks, spec, horizon);
  }
}
