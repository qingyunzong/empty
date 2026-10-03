'use strict';

const {
  KitError,
  SubstituteGraph,
  createState,
  normBatch,
  normOrder,
  normEdge,
} = require('./model');
const { allocate } = require('./allocate');

function findBatch(state, batchId) {
  return state.batches.find((b) => b.id === batchId);
}

// Apply a mutation command to a (already cloned) state. Throws KitError
// on invalid commands; the state may be partially inspected but callers
// discard it on error.
function mutate(state, cmd) {
  switch (cmd.op) {
    case 'addOrder': {
      const order = normOrder(cmd.order);
      if (state.orders.some((o) => o.id === order.id)) {
        throw new KitError('DUPLICATE', `duplicate order: ${order.id}`);
      }
      state.orders.push(order);
      return;
    }
    case 'removeOrder': {
      const index = state.orders.findIndex((o) => o.id === cmd.orderId);
      if (index < 0) throw new KitError('UNKNOWN_ORDER', `unknown order: ${cmd.orderId}`);
      state.orders.splice(index, 1);
      return;
    }
    case 'addBatch': {
      const batch = normBatch(cmd.batch);
      if (findBatch(state, batch.id)) {
        throw new KitError('DUPLICATE', `duplicate batch: ${batch.id}`);
      }
      state.batches.push(batch);
      return;
    }
    case 'removeBatch': {
      const index = state.batches.findIndex((b) => b.id === cmd.batchId);
      if (index < 0) throw new KitError('UNKNOWN_BATCH', `unknown batch: ${cmd.batchId}`);
      state.batches.splice(index, 1);
      return;
    }
    case 'consumeBatch': {
      const batch = findBatch(state, cmd.batchId);
      if (!batch) throw new KitError('UNKNOWN_BATCH', `unknown batch: ${cmd.batchId}`);
      if (!Number.isInteger(cmd.qty) || cmd.qty <= 0) {
        throw new KitError('VALIDATION', `consumeBatch: qty must be a positive integer`);
      }
      if (cmd.qty > batch.qty) {
        throw new KitError(
          'OVER_DEDUCTION',
          `over-deduction: batch ${cmd.batchId} has ${batch.qty}, requested ${cmd.qty}`
        );
      }
      batch.qty -= cmd.qty;
      return;
    }
    case 'freezeBatch': {
      const batch = findBatch(state, cmd.batchId);
      if (!batch) throw new KitError('UNKNOWN_BATCH', `unknown batch: ${cmd.batchId}`);
      batch.status = 'HOLD';
      return;
    }
    case 'releaseBatch': {
      const batch = findBatch(state, cmd.batchId);
      if (!batch) throw new KitError('UNKNOWN_BATCH', `unknown batch: ${cmd.batchId}`);
      batch.status = 'OK';
      return;
    }
    case 'addSubstitute': {
      const [from, to] = normEdge([cmd.from, cmd.to]);
      const graph = new SubstituteGraph(state.substitutes);
      if (graph.hasPath(from, to)) return; // already implied: no-op
      if (graph.createsCycle(from, to)) {
        throw new KitError('CYCLE', `substitution cycle: adding ${from} -> ${to} would close a cycle`);
      }
      state.substitutes.push([from, to]);
      return;
    }
    case 'removeSubstitute': {
      const [from, to] = normEdge([cmd.from, cmd.to]);
      const index = state.substitutes.findIndex(([f, t]) => f === from && t === to);
      if (index < 0) {
        throw new KitError('UNKNOWN_SUBSTITUTE', `unknown substitute: ${from} -> ${to}`);
      }
      state.substitutes.splice(index, 1);
      return;
    }
    default:
      throw new KitError('UNKNOWN_OP', `unknown op: ${cmd.op}`);
  }
}

// Incremental command processor with undo/redo.
//
// Derived data (reservations, shortages, certificates) is never mutated
// in place: every successful command pushes a new immutable snapshot and
// the allocation is recomputed deterministically, so invalidation caused
// by freezes, releases, order changes or substitute corrections
// propagates to all dependent reservations and shortage certificates.
class Engine {
  constructor(input) {
    this.initial = createState(input);
    this.history = [this.initial];
    this.pos = 0;
    this.log = [];
    this.cache = new WeakMap();
  }

  get state() {
    return this.history[this.pos];
  }

  result(state = this.state) {
    let cached = this.cache.get(state);
    if (!cached) {
      cached = allocate(state);
      this.cache.set(state, cached);
    }
    return cached;
  }

  apply(cmd) {
    const entry = { index: this.log.length, op: cmd && cmd.op };
    try {
      if (!cmd || typeof cmd !== 'object' || typeof cmd.op !== 'string') {
        throw new KitError('VALIDATION', 'command must be an object with a string "op"');
      }
      if (cmd.op === 'undo') {
        this.#undo();
      } else if (cmd.op === 'redo') {
        this.#redo();
      } else {
        const next = structuredClone(this.state);
        mutate(next, cmd);
        this.history.length = this.pos + 1; // a new command clears the redo stack
        this.history.push(next);
        this.pos += 1;
      }
      entry.ok = true;
    } catch (err) {
      entry.ok = false;
      entry.error = err.message;
      if (err.code) entry.code = err.code;
    }
    this.log.push(entry);
    return entry;
  }

  applyAll(commands) {
    return commands.map((cmd) => this.apply(cmd));
  }

  #undo() {
    if (this.pos === 0) throw new KitError('UNDO_EMPTY', 'nothing to undo');
    this.pos -= 1;
  }

  #redo() {
    if (this.pos >= this.history.length - 1) throw new KitError('REDO_EMPTY', 'nothing to redo');
    this.pos += 1;
  }

  snapshot() {
    return {
      log: this.log.map((entry) => ({ ...entry })),
      state: this.result(),
    };
  }
}

module.exports = { Engine, mutate };
