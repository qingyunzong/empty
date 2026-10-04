import fs from 'node:fs';
import path from 'node:path';

export class StoreError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'StoreError';
    this.code = code;
  }
}

// WAL record kinds:
//   {kind:'commit', id, writes:[[k,v]...], inverse:[[k,prev,existed]...]}
//   {kind:'undo',   id, target, inverse:[[k,prev,existed]...]}
//   {kind:'redo',   id, target, writes:[[k,v]...]}
//   {kind:'end',    id}   -- completion marker; a record without it is discarded on recovery

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.walPath = path.join(dir, 'wal.log');
    this.statePath = path.join(dir, 'state.json');
    this.data = new Map();      // committed view
    this.txs = new Map();       // open txs: id -> {id,parent,children,writes:Map,inverse:[]}
    this.closed = new Set();    // closed (committed/aborted) tx ids
    this.current = null;        // CLI convenience: current open tx
    this.nextId = 1;
    this.undoStack = [];        // committed outermost txs {id,writes,inverse}
    this.redoStack = [];
    this._walFd = fs.openSync(this.walPath, 'a');
    this._recoverWal();
    this._loadState();
  }

  close() {
    fs.closeSync(this._walFd);
  }

  // ---------- transactions ----------

  begin(parentId = null) {
    let parent = null;
    if (parentId != null) parent = this._openTx(parentId);
    const id = this.nextId++;
    const tx = { id, parent: parent ? parent.id : null, children: [], writes: new Map(), inverse: [] };
    this.txs.set(id, tx);
    if (parent) parent.children.push(id);
    this.current = id;
    this._saveState();
    return id;
  }

  set(txId, key, value) {
    const tx = this._openTx(txId);
    if (!tx.writes.has(key)) {
      const prev = this._readChain(tx, key);
      tx.inverse.push([key, prev.existed ? prev.value : null, prev.existed]);
    }
    tx.writes.set(key, value);
    this._saveState();
  }

  get(key, txId = null) {
    if (txId != null) {
      const tx = this._openTx(txId);
      const r = this._readChain(tx, key);
      return r.existed ? r.value : undefined;
    }
    return this.data.has(key) ? this.data.get(key) : undefined;
  }

  commit(txId) {
    const tx = this._openTx(txId);
    if (tx.children.some((c) => this.txs.has(c))) {
      throw new StoreError('OPEN_CHILDREN', `tx ${txId} has open children`);
    }
    const parent = tx.parent != null ? this.txs.get(tx.parent) : null;
    if (parent) {
      // child commit only merges into the parent; nothing reaches the WAL
      for (const [k, v] of tx.writes) parent.writes.set(k, v);
      parent.inverse = parent.inverse.concat(tx.inverse);
      parent.children = parent.children.filter((c) => c !== txId);
    } else {
      const rec = { kind: 'commit', id: tx.id, writes: [...tx.writes], inverse: tx.inverse };
      this._appendWal(rec);
      for (const [k, v] of tx.writes) this.data.set(k, v);
      this.undoStack.push({ id: tx.id, writes: rec.writes, inverse: rec.inverse });
      this.redoStack = [];
    }
    this._closeTx(tx);
    this._saveState();
  }

  abort(txId) {
    const tx = this.txs.get(txId);
    if (!tx) {
      if (this.closed.has(txId)) throw new StoreError('CLOSED', `tx ${txId} is closed`);
      throw new StoreError('NOT_FOUND', `tx ${txId} not found`);
    }
    // abort this layer and its descendants only; siblings are untouched
    for (const child of [...tx.children]) {
      if (this.txs.has(child)) this.abort(child);
    }
    if (tx.parent != null) {
      const parent = this.txs.get(tx.parent);
      if (parent) parent.children = parent.children.filter((c) => c !== txId);
    }
    this._closeTx(tx);
    this._saveState();
  }

  // ---------- undo / redo of committed outermost transactions ----------

  undo(txId = null, opts = {}) {
    if (this.undoStack.length === 0) throw new StoreError('NOTHING_TO_UNDO');
    if (this.txs.size > 0) throw new StoreError('TX_ACTIVE', 'cannot undo while a transaction is open');
    let idx;
    if (txId == null) {
      idx = this.undoStack.length - 1;
    } else {
      idx = this.undoStack.findIndex((e) => e.id === txId);
      if (idx < 0) throw new StoreError('NOTHING_TO_UNDO', `tx ${txId} is not undoable`);
    }
    const entry = this.undoStack[idx];
    // conflict: a later committed tx overwrote a key this tx wrote
    for (const [k, v] of entry.writes) {
      if (!this.data.has(k) || this.data.get(k) !== v) {
        throw new StoreError('CONFLICT', `undo of tx ${entry.id} conflicts with later writes on key ${k}`);
      }
    }
    const rec = { kind: 'undo', id: this.nextId++, target: entry.id, inverse: entry.inverse };
    this._appendWal(rec, opts); // compensating transaction, atomically marked complete
    this._applyInverse(entry.inverse);
    this.undoStack.splice(idx, 1);
    this.redoStack.push(entry);
    this._saveState();
  }

  redo(opts = {}) {
    if (this.redoStack.length === 0) throw new StoreError('NOTHING_TO_REDO');
    if (this.txs.size > 0) throw new StoreError('TX_ACTIVE', 'cannot redo while a transaction is open');
    const entry = this.redoStack[this.redoStack.length - 1];
    const rec = { kind: 'redo', id: this.nextId++, target: entry.id, writes: entry.writes };
    this._appendWal(rec, opts);
    for (const [k, v] of entry.writes) this.data.set(k, v);
    this.redoStack.pop();
    this.undoStack.push(entry);
    this._saveState();
  }

  // ---------- internals ----------

  _openTx(txId) {
    const tx = this.txs.get(txId);
    if (!tx) {
      if (this.closed.has(txId)) throw new StoreError('CLOSED', `tx ${txId} is closed`);
      throw new StoreError('NOT_FOUND', `tx ${txId} not found`);
    }
    return tx;
  }

  _closeTx(tx) {
    this.txs.delete(tx.id);
    this.closed.add(tx.id);
    if (this.current === tx.id) {
      this.current = tx.parent != null && this.txs.has(tx.parent) ? tx.parent : null;
    }
  }

  _readChain(tx, key) {
    let cur = tx;
    while (cur) {
      if (cur.writes.has(key)) return { existed: true, value: cur.writes.get(key) };
      cur = cur.parent != null ? this.txs.get(cur.parent) : null;
    }
    return this.data.has(key) ? { existed: true, value: this.data.get(key) } : { existed: false, value: null };
  }

  _applyInverse(inverse) {
    for (let i = inverse.length - 1; i >= 0; i--) {
      const [k, prev, existed] = inverse[i];
      if (existed) this.data.set(k, prev);
      else this.data.delete(k);
    }
  }

  _walWrite(rec) {
    fs.writeSync(this._walFd, JSON.stringify(rec) + '\n');
    fs.fsyncSync(this._walFd);
  }

  _appendWal(rec, { crashBeforeBegin = false, crashBeforeEnd = false } = {}) {
    if (crashBeforeBegin) throw new StoreError('CRASH', 'simulated crash before WAL record');
    this._walWrite(rec);
    if (crashBeforeEnd) throw new StoreError('CRASH', 'simulated crash before completion marker');
    this._walWrite({ kind: 'end', id: rec.id });
  }

  _recoverWal() {
    let content;
    try {
      content = fs.readFileSync(this.walPath, 'utf8');
    } catch {
      return;
    }
    const recs = new Map();
    const order = [];
    const ended = new Set();
    let maxId = 0;
    for (const line of content.split('\n')) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // torn tail write
      }
      if (typeof rec.id === 'number') maxId = Math.max(maxId, rec.id);
      if (rec.kind === 'end') ended.add(rec.id);
      else {
        recs.set(rec.id, rec);
        order.push(rec.id);
      }
    }
    for (const id of order) {
      if (!ended.has(id)) continue; // incomplete record: all-or-nothing
      const rec = recs.get(id);
      if (rec.kind === 'commit') {
        for (const [k, v] of rec.writes) this.data.set(k, v);
        this.undoStack.push({ id: rec.id, writes: rec.writes, inverse: rec.inverse });
        this.redoStack = [];
      } else if (rec.kind === 'undo') {
        this._applyInverse(rec.inverse);
        const idx = this.undoStack.findIndex((e) => e.id === rec.target);
        if (idx >= 0) this.redoStack.push(...this.undoStack.splice(idx, 1));
      } else if (rec.kind === 'redo') {
        for (const [k, v] of rec.writes) this.data.set(k, v);
        const idx = this.redoStack.findIndex((e) => e.id === rec.target);
        if (idx >= 0) this.undoStack.push(...this.redoStack.splice(idx, 1));
      }
    }
    this.nextId = maxId + 1;
  }

  _saveState() {
    const state = {
      nextId: this.nextId,
      current: this.current,
      closed: [...this.closed],
      txs: [...this.txs.values()].map((t) => ({
        id: t.id,
        parent: t.parent,
        children: t.children,
        writes: [...t.writes],
        inverse: t.inverse,
      })),
    };
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, this.statePath);
  }

  _loadState() {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return;
    }
    this.nextId = Math.max(this.nextId, state.nextId ?? 1);
    this.current = state.current ?? null;
    this.closed = new Set(state.closed ?? []);
    for (const t of state.txs ?? []) {
      this.txs.set(t.id, { id: t.id, parent: t.parent, children: t.children, writes: new Map(t.writes), inverse: t.inverse });
    }
  }
}
