// Engine: mutable workshop state + operation log + re-optimization.

import { buildState, cloneState, normalizeTask, normalizeCapacity, normalizePrecedence, detectPrecedenceCycle, ModelError, OperationLog, INF } from './model.js';
import { solve, diffSolutions } from './solver.js';

function serializeState(state) {
  return {
    tasks: [...state.tasks.values()].map((t) => ({
      id: t.id,
      line: t.line,
      duration: t.duration,
      release: t.release === 0 ? null : t.release,
      due: t.due === INF ? null : t.due,
    })),
    precedence: state.precedence.map((p) => [...p]),
    capacity: Object.fromEntries([...state.capacity.entries()].map(([line, ws]) => [line, ws.map((w) => ({ ...w }))])),
  };
}

function serializeSolution(solution) {
  if (!solution) return null;
  if (solution.status === 'infeasible') {
    return { status: 'infeasible', certificate: solution.certificate };
  }
  return { status: 'optimal', lmax: solution.lmax, assignments: solution.assignments.map((a) => ({ ...a })) };
}

export class Engine {
  constructor(input = {}) {
    this.state = buildState(input);
    this.log = new OperationLog();
    this.solution = solve(this.state);
  }

  schedule() {
    return {
      schedule: serializeSolution(this.solution),
      undoDepth: this.log.length,
      redoDepth: this.log.entries.length - this.log.pointer,
    };
  }

  apply(op) {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new ModelError('apply expects an operation object');
    }
    const before = cloneState(this.state);
    const label = this.mutate(op);
    this.log.record(label, before, this.state);
    const previous = this.solution;
    this.solution = solve(this.state);
    return this.effect(label, previous);
  }

  mutate(op) {
    switch (op.op) {
      case 'upsertTask': {
        const task = normalizeTask(op.task ?? op, 0);
        const existed = this.state.tasks.has(task.id);
        this.state.tasks.set(task.id, task);
        return `${existed ? 'update' : 'insert'} task ${task.id}`;
      }
      case 'removeTask': {
        const id = op.id ?? op.task;
        if (!this.state.tasks.has(id)) throw new ModelError(`unknown task ${JSON.stringify(id)}`);
        this.state.tasks.delete(id);
        this.state.precedence = this.state.precedence.filter(([a, b]) => a !== id && b !== id);
        return `remove task ${id}`;
      }
      case 'setPrecedence': {
        const edges = normalizePrecedence(op.edges ?? [], new Set(this.state.tasks.keys()));
        const cycle = detectPrecedenceCycle(edges);
        if (cycle) throw new ModelError(`precedence contains a cycle: ${cycle.join(' -> ')}`);
        this.state.precedence = edges;
        return 'set precedence';
      }
      case 'setCapacity': {
        const merged = Object.fromEntries([...this.state.capacity.entries()].map(([l, ws]) => [l, ws.map((w) => ({ ...w }))]));
        for (const [line, windows] of Object.entries(op.capacity ?? {})) {
          merged[line] = windows;
        }
        this.state.capacity = normalizeCapacity(merged);
        return 'set capacity';
      }
      default:
        throw new ModelError(`unknown operation ${JSON.stringify(op.op)}`);
    }
  }

  effect(label, previous) {
    const affected = diffSolutions(previous, this.solution);
    return {
      label,
      schedule: serializeSolution(this.solution),
      affected,
      localRepairSufficient: previous !== null && previous.status === this.solution.status && affected.length === 0,
      undoDepth: this.log.length,
      redoDepth: this.log.entries.length - this.log.pointer,
    };
  }

  undo() {
    const step = this.log.undo();
    if (!step) return { undone: null, message: 'nothing to undo', ...this.schedule() };
    const previous = this.solution;
    this.state = step.state;
    this.solution = solve(this.state);
    return { undone: step.label, ...this.effect(step.label, previous) };
  }

  redo() {
    const step = this.log.redo();
    if (!step) return { redone: null, message: 'nothing to redo', ...this.schedule() };
    const previous = this.solution;
    this.state = step.state;
    this.solution = solve(this.state);
    return { redone: step.label, ...this.effect(step.label, previous) };
  }

  toJSON() {
    return {
      state: serializeState(this.state),
      log: this.log.entries.map((e) => ({
        label: e.label,
        before: serializeState(e.before),
        after: serializeState(e.after),
      })),
      pointer: this.log.pointer,
    };
  }

  static fromJSON(json) {
    const engine = new Engine(json.state ?? {});
    engine.log.entries = (json.log ?? []).map((e) => ({
      label: e.label,
      before: buildState(e.before),
      after: buildState(e.after),
    }));
    engine.log.pointer = json.pointer ?? engine.log.entries.length;
    engine.solution = solve(engine.state);
    return engine;
  }
}
