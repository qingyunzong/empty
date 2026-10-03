import { validateInput } from './model.js';

// Transactional store for base facts (materials, production batches and their
// candidate-parent edges). Derived propagation conclusions live in `derived`
// and are invalidated by every mutation, including undo/redo, so an undo
// removes both the genealogy edges and every conclusion drawn from them.
export class TraceStore {
  constructor() {
    this.materials = new Map();
    this.batches = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.derived = null;
  }

  applyTransaction(txn) {
    const merged = validateInput({
      materials: [...this.materials.values(), ...(txn.materials ?? [])],
      batches: [...this.batches.values(), ...(txn.batches ?? [])],
    });
    const record = {
      materials: merged.materials.slice(this.materials.size),
      batches: merged.batches.slice(this.batches.size),
    };
    for (const m of record.materials) this.materials.set(m.id, m);
    for (const b of record.batches) this.batches.set(b.id, b);
    this.undoStack.push(record);
    this.redoStack = [];
    this.derived = null;
    return record;
  }

  undo() {
    const txn = this.undoStack.pop();
    if (!txn) return null;
    for (const m of txn.materials) this.materials.delete(m.id);
    for (const b of txn.batches) this.batches.delete(b.id);
    this.redoStack.push(txn);
    this.derived = null;
    return txn;
  }

  redo() {
    const txn = this.redoStack.pop();
    if (!txn) return null;
    for (const m of txn.materials) this.materials.set(m.id, m);
    for (const b of txn.batches) this.batches.set(b.id, b);
    this.undoStack.push(txn);
    this.derived = null;
    return txn;
  }

  toJSON() {
    return { undoStack: this.undoStack, redoStack: this.redoStack };
  }

  static from(state) {
    if (state === null || typeof state !== 'object') {
      throw new Error('state must be an object');
    }
    const store = new TraceStore();
    for (const txn of state.undoStack ?? []) store.applyTransaction(txn);
    store.redoStack = (state.redoStack ?? []).map((txn) => ({
      materials: txn.materials ?? [],
      batches: txn.batches ?? [],
    }));
    return store;
  }
}
