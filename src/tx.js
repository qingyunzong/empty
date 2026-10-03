import { applyOp } from './state.js';
import { BizError, SimulatedCrash } from './errors.js';

let counter = 0;

export class Tx {
  constructor(store) {
    this.store = store;
    this.id = `tx-${Date.now()}-${++counter}`;
    this.state = structuredClone(store.state);
    this.frames = [];
    this.done = false;
    store.wal.append({ type: 'begin', tx: this.id });
  }

  _assertActive() {
    if (this.done) throw new BizError('transaction already finished');
  }

  _op(data) {
    this._assertActive();
    applyOp(this.state, data);
    this.store.wal.append({ type: 'op', tx: this.id, data });
  }

  create(args) { this._op({ op: 'create', ...args }); }
  split(args) { this._op({ op: 'split', ...args }); }
  merge(args) { this._op({ op: 'merge', ...args }); }
  link(args) { this._op({ op: 'link', ...args }); }
  qc(args) { this._op({ op: 'qc', ...args }); }

  savepoint(name) {
    this._assertActive();
    this.frames.push({ name, saved: structuredClone(this.state) });
  }

  _findFrame(name) {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].name === name) return i;
    }
    return -1;
  }

  release(name) {
    this._assertActive();
    const i = this._findFrame(name);
    if (i < 0) throw new BizError(`no such savepoint: ${name}`);
    // Release only drops the boundary (and later boundaries); changes are kept.
    this.frames.length = i;
  }

  rollback(name) {
    this._assertActive();
    const i = this._findFrame(name);
    if (i < 0) throw new BizError(`no such savepoint: ${name}`);
    this.state = structuredClone(this.frames[i].saved);
    this.frames.length = i + 1; // the savepoint itself survives
  }

  commit(opts = {}) {
    this._assertActive();
    if (opts.crash === 'beforeMarker') {
      this.store.wal.fsync();
      this.done = true;
      this.store.activeTx = null;
      throw new SimulatedCrash('simulated crash before commit marker');
    }
    const cert = this.store._commit(this, opts);
    this.done = true;
    this.store.activeTx = null;
    return cert;
  }
}
