'use strict';

const { validateProblem, stableStringify, ValidationError } = require('./model');
const { solve } = require('./solver');

function clone(value) {
  return structuredClone(value);
}

function summarizeTask(entry) {
  if (!entry) return null;
  if (entry.state === 'deferred') return { state: 'deferred', reason: entry.reason };
  return {
    state: 'scheduled',
    mode: entry.mode,
    crew: entry.crew,
    start: entry.start,
    end: entry.end,
  };
}

function diffResults(prev, next) {
  const changes = [];
  const ids = [...new Set([...Object.keys(prev.tasks), ...Object.keys(next.tasks)])].sort();
  for (const id of ids) {
    const a = prev.tasks[id];
    const b = next.tasks[id];
    if (!a) {
      changes.push({ task: id, type: 'added', to: summarizeTask(b) });
    } else if (!b) {
      changes.push({ task: id, type: 'removed', from: summarizeTask(a) });
    } else if (a.state !== b.state) {
      changes.push({
        task: id,
        type: b.state === 'deferred' ? 'deferred' : 'restored',
        from: summarizeTask(a),
        to: summarizeTask(b),
      });
    } else if (b.state === 'scheduled' &&
        (a.mode !== b.mode || a.crew !== b.crew || a.start !== b.start || a.end !== b.end)) {
      changes.push({
        task: id,
        type: a.mode !== b.mode ? 'mode-changed' : 'rescheduled',
        from: summarizeTask(a),
        to: summarizeTask(b),
      });
    }
  }
  return {
    downtime: {
      from: prev.objective.downtime,
      to: next.objective.downtime,
      delta: next.objective.downtime - prev.objective.downtime,
    },
    cost: {
      from: prev.objective.cost,
      to: next.objective.cost,
      delta: next.objective.cost - prev.objective.cost,
    },
    changes,
  };
}

function applyMutation(problem, cmd) {
  if (typeof cmd !== 'object' || cmd === null || typeof cmd.type !== 'string') {
    throw new ValidationError('INVALID_COMMAND', 'command must be an object with a string "type"');
  }
  const raw = clone(problem);
  switch (cmd.type) {
    case 'setBudget': {
      raw.budget = cmd.budget; // validated (incl. negative) by validateProblem
      return raw;
    }
    case 'addTask': {
      if (typeof cmd.task !== 'object' || cmd.task === null) {
        throw new ValidationError('INVALID_COMMAND', 'addTask requires a "task" object');
      }
      raw.tasks.push(clone(cmd.task));
      return raw;
    }
    case 'removeTask': {
      if (typeof cmd.taskId !== 'string') {
        throw new ValidationError('INVALID_COMMAND', 'removeTask requires a "taskId" string');
      }
      if (!raw.tasks.some((t) => t.id === cmd.taskId)) {
        throw new ValidationError('UNKNOWN_TASK', `cannot remove unknown task "${cmd.taskId}"`);
      }
      raw.tasks = raw.tasks.filter((t) => t.id !== cmd.taskId);
      // Dependents lose the dangling edge (documented removeTask semantics).
      for (const t of raw.tasks) {
        t.deps = (t.deps || []).filter((d) => d !== cmd.taskId);
      }
      return raw;
    }
    case 'updateModeCost': {
      if (typeof cmd.taskId !== 'string' || typeof cmd.modeId !== 'string') {
        throw new ValidationError('INVALID_COMMAND', 'updateModeCost requires "taskId" and "modeId" strings');
      }
      const task = raw.tasks.find((t) => t.id === cmd.taskId);
      if (!task) {
        throw new ValidationError('UNKNOWN_TASK', `unknown task "${cmd.taskId}"`);
      }
      const mode = task.modes.find((m) => m.id === cmd.modeId);
      if (!mode) {
        throw new ValidationError('UNKNOWN_MODE', `unknown mode "${cmd.modeId}" on task "${cmd.taskId}"`);
      }
      mode.cost = cmd.cost; // validated by validateProblem
      return raw;
    }
    default:
      throw new ValidationError('UNKNOWN_COMMAND', `unknown command type "${cmd.type}"`);
  }
}

// Incremental maintenance store: keeps a command journal with undo/redo
// stacks, and memoizes solver results keyed by the canonical problem hash so
// revisiting states (undo/redo, repeated configurations) is O(1).
class MaintenanceStore {
  constructor(rawProblem) {
    this.problem = validateProblem(rawProblem);
    this.past = [];
    this.future = [];
    this.resultCache = new Map();
  }

  currentResult() {
    const key = stableStringify(this.problem);
    if (!this.resultCache.has(key)) {
      this.resultCache.set(key, solve(this.problem));
    }
    return this.resultCache.get(key);
  }

  applyCommand(cmd) {
    if (cmd && cmd.type === 'undo') return this.undo();
    if (cmd && cmd.type === 'redo') return this.redo();
    const prevResult = this.currentResult();
    const next = validateProblem(applyMutation(this.problem, cmd));
    this.past.push(this.problem);
    this.future = [];
    this.problem = next;
    const result = this.currentResult();
    return { status: 'ok', diff: diffResults(prevResult, result), result };
  }

  undo() {
    if (this.past.length === 0) {
      throw new ValidationError('NOTHING_TO_UNDO', 'no command to undo');
    }
    const prevResult = this.currentResult();
    this.future.push(this.problem);
    this.problem = this.past.pop();
    const result = this.currentResult();
    return { status: 'ok', diff: diffResults(prevResult, result), result };
  }

  redo() {
    if (this.future.length === 0) {
      throw new ValidationError('NOTHING_TO_REDO', 'no command to redo');
    }
    const prevResult = this.currentResult();
    this.past.push(this.problem);
    this.problem = this.future.pop();
    const result = this.currentResult();
    return { status: 'ok', diff: diffResults(prevResult, result), result };
  }
}

module.exports = { MaintenanceStore, diffResults, applyMutation };
