// Incremental scheduler: maintains the problem state under a stream of
// commands (task add/remove, mode reprice/update, budget adjust), supports
// undo/redo of every command, and memoizes exact solutions by canonical
// state hash so that revisiting a state (undo/redo, no-op edits) is O(1).

import {
  ProblemError,
  validateProblem,
  validateTask,
  checkDependencies,
  hashState,
  cloneState,
  criticalPath,
} from './model.js';
import { solve } from './solver.js';

function sortedCopy(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

export function criticalConstraints(state, result) {
  if (result.status !== 'optimal') {
    return {
      binding: [],
      violations: result.violations || [],
    };
  }
  const binding = [];
  if (result.cost === state.budget) {
    binding.push({ type: 'budget', used: result.cost, limit: state.budget });
  }
  for (const p of Object.keys(state.parts)) {
    const used = result.partsUsed[p] || 0;
    if (used === state.parts[p]) {
      binding.push({ type: 'part', part: p, used, limit: state.parts[p] });
    }
  }
  const modeOf = (id) => result.modes[id];
  const cp = criticalPath(state, modeOf);
  return {
    budget: { used: result.cost, limit: state.budget, binding: result.cost === state.budget },
    parts: Object.keys(state.parts).map((p) => ({
      part: p,
      used: result.partsUsed[p] || 0,
      limit: state.parts[p],
      binding: (result.partsUsed[p] || 0) === state.parts[p],
    })),
    criticalPath: cp.path,
    criticalPathDuration: cp.len,
    binding,
    violations: [],
  };
}

export function diffResults(prev, curr) {
  const diff = {};
  if (!prev || prev.status !== curr.status) {
    diff.statusChanged = { from: prev ? prev.status : null, to: curr.status };
  }
  if (prev && prev.status === 'optimal' && curr.status === 'optimal') {
    if (prev.downtime !== curr.downtime) diff.downtimeDelta = curr.downtime - prev.downtime;
    if (prev.cost !== curr.cost) diff.costDelta = curr.cost - prev.cost;
    const added = [];
    const removed = [];
    const changed = [];
    for (const id of Object.keys(curr.perTask)) {
      if (!prev.perTask[id]) {
        added.push(curr.perTask[id]);
      } else {
        const a = prev.perTask[id];
        const b = curr.perTask[id];
        if (a.crew !== b.crew || a.start !== b.start || a.end !== b.end || a.mode !== b.mode) {
          changed.push({ task: id, from: a, to: b });
        }
      }
    }
    for (const id of Object.keys(prev.perTask)) {
      if (!curr.perTask[id]) removed.push(prev.perTask[id]);
    }
    if (added.length) diff.intervalsAdded = added;
    if (removed.length) diff.intervalsRemoved = removed;
    if (changed.length) diff.intervalsChanged = changed;
    if (JSON.stringify(prev.sequence) !== JSON.stringify(curr.sequence)) {
      diff.sequenceChanged = { from: prev.sequence, to: curr.sequence };
    }
  }
  return diff;
}

export class Scheduler {
  constructor(input) {
    this.state = validateProblem(input);
    this.cache = new Map(); // stateHash -> solve result (object is frozen-by-convention)
    this.undoStack = [];    // inverse commands
    this.redoStack = [];    // forward commands
    this.lastResult = null;
  }

  solveCurrent() {
    const hash = hashState(this.state);
    let result = this.cache.get(hash);
    if (!result) {
      result = solve(this.state);
      this.cache.set(hash, result);
    }
    return result;
  }

  // Build the full step report for the current state.
  report(command, extra = {}) {
    const result = this.solveCurrent();
    const step = {
      command: command === null ? null : { ...command },
      stateHash: hashState(this.state),
      status: result.status,
      ...extra,
    };
    if (result.status === 'optimal') {
      step.schedule = {
        crews: result.crews,
        intervals: result.intervals,
        downtime: result.downtime,
        cost: result.cost,
        sequence: result.sequence,
        modes: sortedCopy(result.modes),
        partsUsed: sortedCopy(result.partsUsed),
      };
    } else {
      step.violations = result.violations;
    }
    step.criticalConstraints = criticalConstraints(this.state, result);
    step.certificate = result.certificate;
    step.diff = diffResults(this.lastResult, result);
    this.lastResult = result;
    return step;
  }

  taskIndex(id) {
    return this.state.tasks.findIndex((t) => t.id === id);
  }

  // Apply a mutation without touching undo/redo stacks. Throws ProblemError.
  applyRaw(cmd) {
    const c = this.state;
    switch (cmd.op) {
      case 'addTask': {
        const task = validateTask(cmd.task, c.parts, 'addTask');
        if (this.taskIndex(task.id) !== -1) {
          throw new ProblemError('DUPLICATE_TASK', `task "${task.id}" already exists`, { task: task.id });
        }
        const next = cloneState(c);
        next.tasks.push(task);
        next.tasks.sort((a, b) => (a.id < b.id ? -1 : 1));
        checkDependencies(next);
        this.state = next;
        return { op: 'removeTask', id: task.id, _restore: null };
      }
      case 'removeTask': {
        const idx = this.taskIndex(cmd.id);
        if (idx === -1) {
          throw new ProblemError('UNKNOWN_TASK', `cannot remove unknown task "${cmd.id}"`, { task: cmd.id });
        }
        const next = cloneState(c);
        const [removed] = next.tasks.splice(idx, 1);
        const dependents = [];
        for (const t of next.tasks) {
          const i = t.deps.indexOf(cmd.id);
          if (i !== -1) {
            t.deps.splice(i, 1);
            dependents.push(t.id);
          }
        }
        this.state = next;
        return { op: 'restoreTask', task: removed, dependents };
      }
      case 'restoreTask': { // internal: inverse of removeTask
        const next = cloneState(c);
        next.tasks.push(cmd.task);
        next.tasks.sort((a, b) => (a.id < b.id ? -1 : 1));
        for (const dep of cmd.dependents || []) {
          const t = next.tasks.find((x) => x.id === dep);
          if (t && !t.deps.includes(cmd.task.id)) {
            t.deps.push(cmd.task.id);
            t.deps.sort();
          }
        }
        checkDependencies(next);
        this.state = next;
        return { op: 'removeTask', id: cmd.task.id };
      }
      case 'updateMode':
      case 'repriceMode': {
        const idx = this.taskIndex(cmd.task);
        if (idx === -1) {
          throw new ProblemError('UNKNOWN_TASK', `unknown task "${cmd.task}"`, { task: cmd.task });
        }
        const task = c.tasks[idx];
        const mi = cmd.mode;
        if (!Number.isInteger(mi) || mi < 0 || mi >= task.modes.length) {
          throw new ProblemError('UNKNOWN_MODE', `task "${cmd.task}" has no mode ${mi}`, { task: cmd.task, mode: mi });
        }
        const patch = cmd.op === 'repriceMode' ? { cost: cmd.cost } : (cmd.patch || {});
        const oldMode = task.modes[mi];
        const merged = {
          duration: patch.duration !== undefined ? patch.duration : oldMode.duration,
          cost: patch.cost !== undefined ? patch.cost : oldMode.cost,
          parts: patch.parts !== undefined ? patch.parts : oldMode.parts,
        };
        const validated = validateTask(
          { id: task.id, deps: [], modes: [merged] },
          c.parts,
          `updateMode task "${cmd.task}" mode ${mi}`,
        ).modes[0];
        const next = cloneState(c);
        next.tasks[idx].modes[mi] = validated;
        this.state = next;
        return {
          op: 'updateMode',
          task: cmd.task,
          mode: mi,
          patch: { duration: oldMode.duration, cost: oldMode.cost, parts: oldMode.parts },
        };
      }
      case 'setBudget': {
        if (typeof cmd.budget !== 'number' || !Number.isInteger(cmd.budget)) {
          throw new ProblemError('INVALID_COMMAND', 'setBudget: budget must be an integer');
        }
        if (cmd.budget < 0) {
          throw new ProblemError('NEGATIVE_BUDGET', `budget must be non-negative, got ${cmd.budget}`, { budget: cmd.budget });
        }
        const next = cloneState(c);
        next.budget = cmd.budget;
        this.state = next;
        return { op: 'setBudget', budget: c.budget };
      }
      default:
        throw new ProblemError('UNKNOWN_COMMAND', `unknown command op "${cmd.op}"`, { op: cmd.op });
    }
  }

  // Apply one command from the stream. Returns the step report; command
  // errors are reported in-band and leave the state untouched.
  applyCommand(cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.op !== 'string') {
      return this.errorStep(cmd, 'INVALID_COMMAND', 'command must be an object with a string "op"');
    }
    if (cmd.op === 'undo') return this.undo();
    if (cmd.op === 'redo') return this.redo();
    let inverse;
    try {
      inverse = this.applyRaw(cmd);
    } catch (err) {
      if (err instanceof ProblemError) {
        return this.errorStep(cmd, err.code, err.message, err.details);
      }
      throw err;
    }
    this.undoStack.push(inverse);
    this.redoStack.length = 0;
    return this.report(cmd);
  }

  errorStep(cmd, code, message, details) {
    const step = {
      command: cmd === null ? null : { ...cmd },
      stateHash: hashState(this.state),
      status: 'error',
      error: { code, message, ...(details !== undefined ? { details } : {}) },
      diff: {},
    };
    return step;
  }

  undo() {
    if (this.undoStack.length === 0) {
      return { command: { op: 'undo' }, stateHash: hashState(this.state), status: 'noop', reason: 'nothing to undo', diff: {} };
    }
    const inverse = this.undoStack.pop();
    const forward = this.applyRaw(inverse);
    this.redoStack.push(forward);
    return this.report({ op: 'undo' });
  }

  redo() {
    if (this.redoStack.length === 0) {
      return { command: { op: 'redo' }, stateHash: hashState(this.state), status: 'noop', reason: 'nothing to redo', diff: {} };
    }
    const forward = this.redoStack.pop();
    const inverse = this.applyRaw(forward);
    this.undoStack.push(inverse);
    return this.report({ op: 'redo' });
  }

  initialReport() {
    return this.report(null);
  }
}

export function runCommandStream(input, commands) {
  const scheduler = new Scheduler(input);
  const steps = [{ index: 0, ...scheduler.initialReport() }];
  commands.forEach((cmd, i) => {
    steps.push({ index: i + 1, ...scheduler.applyCommand(cmd) });
  });
  return { scheduler, steps };
}
