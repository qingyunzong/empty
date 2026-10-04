// Event-log engine: applies the JSONL event stream, maintains the incremental
// catalog state, manages the checkpoint stack (undo_to), and runs the solver.
import { createState, applyAdd, applyRetract, applyCorrect, DEFAULT_CONFIG, InputError } from './model.js';
import { validateEvent } from './validate.js';
import { solveCatalog, DEFAULT_BUDGET } from './solver.js';

export class Engine {
  constructor(config = DEFAULT_CONFIG) {
    this.state = createState(config);
    this.events = [];      // effective event log (raw events, as applied)
    this.checkpoints = []; // stack of {name, logLength, snapshot}
    this.lastCells = null; // cells of the last SAT model: {night: {star: cell}}
    this.dirty = [];       // event indices that mutated state since the last SAT solve
    this.defaultBudget = { ...DEFAULT_BUDGET };
  }

  applyEvent(raw) {
    const parsed = validateEvent(raw, this.state, this.events.length === 0);
    const index = this.events.length;
    switch (parsed.type) {
      case 'config': {
        this.state = createState(parsed.config);
        this.events.push(raw);
        return { type: 'ack', event: index, op: 'config', ...parsed.config };
      }
      case 'add_obs': {
        parsed.obs.events.push(index);
        applyAdd(this.state, parsed.obs);
        this.dirty.push(index);
        this.events.push(raw);
        return { type: 'ack', event: index, op: 'add_obs', id: parsed.obs.id };
      }
      case 'retract_obs': {
        applyRetract(this.state, parsed.id);
        this.dirty.push(index);
        this.events.push(raw);
        return { type: 'ack', event: index, op: 'retract_obs', id: parsed.id };
      }
      case 'correct_obs': {
        applyCorrect(this.state, parsed.id, parsed.patch);
        this.state.obs[parsed.id].events.push(index);
        this.dirty.push(index);
        this.events.push(raw);
        return { type: 'ack', event: index, op: 'correct_obs', id: parsed.id };
      }
      case 'checkpoint': {
        if (this.checkpoints.some((c) => c.name === parsed.name)) {
          throw new InputError(`duplicate checkpoint '${parsed.name}'`);
        }
        this.events.push(raw);
        this.checkpoints.push({ name: parsed.name, logLength: this.events.length, snapshot: this.snapshot() });
        return { type: 'ack', event: index, op: 'checkpoint', name: parsed.name, depth: this.checkpoints.length };
      }
      case 'undo_to':
        return this.undoTo(parsed.name, raw);
      case 'solve':
        return this.solve(parsed.budget, raw);
      default:
        throw new InputError(`unsupported event type '${parsed.type}'`);
    }
  }

  snapshot() {
    return {
      state: structuredClone(this.state),
      lastCells: structuredClone(this.lastCells),
      dirty: [...this.dirty],
    };
  }

  // Level-skipping is forbidden: undo_to may only restore the top of the
  // checkpoint stack. Naming a deeper checkpoint rolls back only to the
  // nearest consistent point (the top) and reports UNDO_LEVEL_SKIP.
  undoTo(name, raw) {
    if (this.checkpoints.length === 0) throw new InputError('undo_to: checkpoint stack is empty');
    if (!this.checkpoints.some((c) => c.name === name)) {
      throw new InputError(`undo_to: unknown checkpoint '${name}'`);
    }
    const top = this.checkpoints[this.checkpoints.length - 1];
    const skipped = top.name !== name;
    this.checkpoints.pop();
    this.state = structuredClone(top.snapshot.state);
    this.lastCells = structuredClone(top.snapshot.lastCells);
    this.dirty = [...top.snapshot.dirty];
    this.events.length = top.logLength;
    const index = this.events.length;
    this.events.push(raw);
    const out = { type: 'undo', event: index, requested: name, restored: top.name };
    if (skipped) out.warning = 'UNDO_LEVEL_SKIP';
    return out;
  }

  solve(budget, raw) {
    const effective = { ...this.defaultBudget, ...(budget ?? {}) };
    const trigger = [...this.dirty];
    const r = solveCatalog(this.state, effective);
    const index = this.events.length;
    this.events.push(raw);
    const out = {
      type: 'solve_result',
      event: index,
      status: r.status,
      stats: r.stats,
      budget: { requested: effective, remaining: r.remaining },
      trigger,
      explanation: r.explanation,
    };
    if (r.status === 'SAT') {
      out.model = r.model;
      out.cells = r.cells;
      out.superseded = r.superseded;
      out.reassignments = this.computeReassignments(r.cells);
      this.lastCells = structuredClone(r.cells);
      this.dirty = [];
    } else if (r.status === 'UNSAT') {
      out.conflict = r.conflict;
      out.unsatCore = r.unsatCore;
    } else {
      out.reason = r.reason;
      out.exceeded = r.exceeded;
      out.partial = r.partial;
    }
    return out;
  }

  computeReassignments(cells) {
    const out = [];
    if (!this.lastCells) return out;
    for (const night of Object.keys(cells).sort((a, b) => a - b)) {
      for (const star of Object.keys(cells[night]).sort()) {
        const prev = this.lastCells[night]?.[star];
        if (prev !== undefined && prev !== cells[night][star]) {
          out.push({
            star,
            night: Number(night),
            from: prev,
            to: cells[night][star],
            cause: { constraint: 'exclusive_cell', trigger: [...this.dirty] },
          });
        }
      }
    }
    return out;
  }
}

// Replay an event log from scratch into a fresh engine.
export function replay(events, config) {
  const engine = new Engine(config);
  const outputs = events.map((ev) => engine.applyEvent(ev));
  return { engine, outputs };
}
