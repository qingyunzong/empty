import fs from 'node:fs';
import path from 'node:path';
import { Wal } from './wal.js';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

const valuesEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const removeFirst = (arr, item) => {
  const i = arr.lastIndexOf(item);
  if (i >= 0) arr.splice(i, 1);
  return i >= 0;
};

export class Transaction {
  constructor(store, id, parent) {
    this.store = store;
    this.id = id;
    this.parent = parent;
    this.status = 'open'; // open | committed | aborted
    this.ops = new Map(); // key -> { hasValue, value }
    this.children = new Set();
  }

  _assertOpen() {
    if (this.status !== 'open') {
      throw new StoreError('CLOSED', `transaction ${this.id} is ${this.status}`);
    }
  }

  begin() {
    this._assertOpen();
    const child = new Transaction(this.store, this.store._allocTxId(), this);
    this.children.add(child);
    return child;
  }

  set(key, value) {
    this._assertOpen();
    this.ops.set(key, { hasValue: true, value });
  }

  del(key) {
    this._assertOpen();
    this.ops.set(key, { hasValue: false, value: undefined });
  }

  get(key) {
    this._assertOpen();
    for (let tx = this; tx; tx = tx.parent) {
      if (tx.ops.has(key)) {
        const op = tx.ops.get(key);
        return op.hasValue ? op.value : undefined;
      }
    }
    return this.store.get(key);
  }

  commit() {
    this._assertOpen();
    // Open descendants are discarded: their writes never merged.
    for (const child of [...this.children]) {
      if (child.status === 'open') child.abort();
    }
    this.status = 'committed';
    if (this.parent) {
      // Sub-transaction commit: merge into parent only, nothing hits the WAL.
      for (const [key, op] of this.ops) this.parent.ops.set(key, op);
      this.parent.children.delete(this);
      this.parent = null;
    } else {
      this.store._commitRoot(this);
    }
  }

  abort() {
    if (this.status !== 'open') {
      throw new StoreError('CLOSED', `transaction ${this.id} is ${this.status}`);
    }
    for (const child of [...this.children]) {
      if (child.status === 'open') child.abort();
    }
    this.status = 'aborted';
    if (this.parent) {
      this.parent.children.delete(this);
      this.parent = null;
    }
  }
}

export class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.wal = new Wal(path.join(dir, 'wal.log'));
    this.committed = new Map(); // key -> value (durable state)
    this.committedTxs = new Map(); // txId -> { id, kind, target, sets }
    this.undoStack = []; // txIds, most recent last
    this.redoStack = [];
    this._nextTxId = 1;
    // Test hook: invoked after a tx's data records are fsynced but before
    // its commit marker is written. Throwing here simulates a crash.
    this.hooks = { beforeCommitMarker: null };
    this._replay();
  }

  _allocTxId() {
    return this._nextTxId++;
  }

  _replay() {
    const pending = new Map();
    for (const rec of this.wal.read()) {
      if (rec.type === 'begin') {
        pending.set(rec.tx, {
          id: rec.tx,
          kind: rec.kind || 'normal',
          target: rec.target ?? null,
          sets: new Map(),
        });
        this._nextTxId = Math.max(this._nextTxId, rec.tx + 1);
      } else if (rec.type === 'set') {
        const tx = pending.get(rec.tx);
        if (tx) {
          tx.sets.set(rec.key, {
            hasValue: rec.hasValue,
            value: rec.value,
            hasPrev: rec.hasPrev,
            prev: rec.prev,
          });
        }
      } else if (rec.type === 'commit') {
        const tx = pending.get(rec.tx);
        if (!tx) continue;
        pending.delete(rec.tx);
        this._applyCommitted(tx);
      }
    }
    // Transactions without a commit marker never happened.
  }

  _applyCommitted(tx) {
    for (const [key, s] of tx.sets) {
      if (s.hasValue) this.committed.set(key, s.value);
      else this.committed.delete(key);
    }
    this.committedTxs.set(tx.id, tx);
    this._nextTxId = Math.max(this._nextTxId, tx.id + 1);
    if (tx.kind === 'normal') {
      this.undoStack.push(tx.id);
      this.redoStack = [];
    } else if (tx.kind === 'undo') {
      removeFirst(this.undoStack, tx.target);
      this.redoStack.push(tx.target);
    } else if (tx.kind === 'redo') {
      removeFirst(this.redoStack, tx.target);
      this.undoStack.push(tx.target);
    }
  }

  _writeTx(tx) {
    this.wal.append({ type: 'begin', tx: tx.id, kind: tx.kind, target: tx.target });
    for (const [key, s] of tx.sets) {
      this.wal.append({
        type: 'set',
        tx: tx.id,
        key,
        hasValue: s.hasValue,
        value: s.value,
        hasPrev: s.hasPrev,
        prev: s.prev,
      });
    }
    this.wal.sync();
    if (this.hooks.beforeCommitMarker) this.hooks.beforeCommitMarker(tx);
    this.wal.append({ type: 'commit', tx: tx.id });
    this.wal.sync();
  }

  _commitRoot(tx) {
    const sets = new Map();
    for (const [key, op] of tx.ops) {
      const hasPrev = this.committed.has(key);
      sets.set(key, {
        hasValue: op.hasValue,
        value: op.value,
        hasPrev,
        prev: hasPrev ? this.committed.get(key) : undefined,
      });
    }
    const record = { id: tx.id, kind: 'normal', target: null, sets };
    this._writeTx(record);
    this._applyCommitted(record);
  }

  begin(id) {
    const txId = id ?? this._allocTxId();
    this._nextTxId = Math.max(this._nextTxId, txId + 1);
    return new Transaction(this, txId, null);
  }

  get(key) {
    return this.committed.get(key);
  }

  has(key) {
    return this.committed.has(key);
  }

  snapshot() {
    return Object.fromEntries(this.committed);
  }

  undo(txId) {
    const id = txId ?? this.undoStack[this.undoStack.length - 1];
    if (id === undefined || !this.undoStack.includes(id)) {
      throw new StoreError('NOTHING_TO_UNDO', 'undo stack is empty');
    }
    const target = this.committedTxs.get(id);
    // Conflict: a later committed change touched a key this tx wrote.
    for (const [key, s] of target.sets) {
      const curHas = this.committed.has(key);
      if (curHas !== s.hasValue) {
        throw new StoreError('CONFLICT', `key ${JSON.stringify(key)} was modified after tx ${id}`);
      }
      if (s.hasValue && !valuesEqual(this.committed.get(key), s.value)) {
        throw new StoreError('CONFLICT', `key ${JSON.stringify(key)} was modified after tx ${id}`);
      }
    }
    // Inverse compensation: restore each key's pre-tx value.
    const sets = new Map();
    for (const [key, s] of target.sets) {
      sets.set(key, {
        hasValue: s.hasPrev,
        value: s.prev,
        hasPrev: s.hasValue,
        prev: s.value,
      });
    }
    const undoTx = { id: this._allocTxId(), kind: 'undo', target: id, sets };
    this._writeTx(undoTx);
    this._applyCommitted(undoTx);
    return undoTx.id;
  }

  redo(txId) {
    const id = txId ?? this.redoStack[this.redoStack.length - 1];
    if (id === undefined || !this.redoStack.includes(id)) {
      throw new StoreError('NOTHING_TO_REDO', 'redo stack is empty');
    }
    const target = this.committedTxs.get(id);
    // Conflict: current state is not the post-undo state anymore.
    for (const [key, s] of target.sets) {
      const curHas = this.committed.has(key);
      if (curHas !== s.hasPrev) {
        throw new StoreError('CONFLICT', `key ${JSON.stringify(key)} was modified after undo of tx ${id}`);
      }
      if (s.hasPrev && !valuesEqual(this.committed.get(key), s.prev)) {
        throw new StoreError('CONFLICT', `key ${JSON.stringify(key)} was modified after undo of tx ${id}`);
      }
    }
    const sets = new Map();
    for (const [key, s] of target.sets) {
      sets.set(key, {
        hasValue: s.hasValue,
        value: s.value,
        hasPrev: s.hasPrev,
        prev: s.prev,
      });
    }
    const redo = { id: this._allocTxId(), kind: 'redo', target: id, sets };
    this._writeTx(redo);
    this._applyCommitted(redo);
    return redo.id;
  }

  log() {
    const txs = [...this.committedTxs.values()].map((t) => ({
      id: t.id,
      kind: t.kind,
      target: t.target,
      sets: Object.fromEntries(
        [...t.sets].map(([k, s]) => [k, s.hasValue ? s.value : '<deleted>']),
      ),
    }));
    return {
      txs,
      undoStack: [...this.undoStack],
      redoStack: [...this.redoStack],
    };
  }

  close() {
    this.wal.close();
  }
}
