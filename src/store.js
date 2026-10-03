// Transactional trace store with undo/redo.
//
// Every mutation goes through a store method which, while a transaction is
// open, records a serializable inverse op. undo() replays inverses in
// reverse order, so genealogy edges and propagated conclusions (derived
// facts) are removed together; redo() replays the forward ops.

export class TraceStore {
  constructor(state) {
    this.state = state ?? { batches: {}, edges: [], derived: {} };
    this.undoStack = [];
    this.redoStack = [];
    this._txn = null;
  }

  begin(label) {
    if (this._txn) throw new Error('transaction already open');
    this._txn = { label, ops: [] };
  }

  commit() {
    if (!this._txn) throw new Error('no open transaction');
    const txn = this._txn;
    this._txn = null;
    if (txn.ops.length > 0) {
      this.undoStack.push(txn);
      this.redoStack = [];
    }
    return txn.label;
  }

  _record(inverse, forward) {
    if (this._txn) this._txn.ops.push({ inverse, forward });
  }

  addBatch(batch) {
    this.state.batches[batch.id] = batch;
    this._record(
      { op: 'removeBatch', id: batch.id },
      { op: 'addBatch', batch },
    );
  }

  addEdge(edge) {
    const index = this.state.edges.length;
    this.state.edges.push(edge);
    this._record(
      { op: 'removeEdgeAt', index },
      { op: 'addEdge', edge },
    );
  }

  setDerived(key, value) {
    const had = Object.hasOwn(this.state.derived, key);
    const old = this.state.derived[key];
    this.state.derived[key] = value;
    this._record(
      had ? { op: 'setDerived', key, value: old } : { op: 'deleteDerived', key },
      { op: 'setDerived', key, value },
    );
  }

  static _apply(state, op) {
    switch (op.op) {
      case 'addBatch':
        state.batches[op.batch.id] = op.batch;
        break;
      case 'removeBatch':
        delete state.batches[op.id];
        break;
      case 'addEdge':
        state.edges.push(op.edge);
        break;
      case 'removeEdgeAt':
        state.edges.splice(op.index, 1);
        break;
      case 'setDerived':
        state.derived[op.key] = op.value;
        break;
      case 'deleteDerived':
        delete state.derived[op.key];
        break;
      default:
        throw new Error(`unknown op: ${op.op}`);
    }
  }

  undo() {
    const txn = this.undoStack.pop();
    if (!txn) return null;
    for (let i = txn.ops.length - 1; i >= 0; i--) {
      TraceStore._apply(this.state, txn.ops[i].inverse);
    }
    this.redoStack.push(txn);
    return txn.label;
  }

  redo() {
    const txn = this.redoStack.pop();
    if (!txn) return null;
    for (const entry of txn.ops) {
      TraceStore._apply(this.state, entry.forward);
    }
    this.undoStack.push(txn);
    return txn.label;
  }

  toJSON() {
    return {
      state: this.state,
      undoStack: this.undoStack,
      redoStack: this.redoStack,
    };
  }

  static from(json) {
    const store = new TraceStore(json.state);
    store.undoStack = json.undoStack ?? [];
    store.redoStack = json.redoStack ?? [];
    return store;
  }
}
