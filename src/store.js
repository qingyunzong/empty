'use strict';

const { LineageGraph } = require('./lineage');
const { Wal } = require('./wal');

// Durable store: lineage graph + op log with undo/redo, persisted via WAL.
//
// Mutations are recorded as ops; undo/redo move an applied pointer over the
// op log. Every pointer movement is itself WAL-committed, so undo/redo
// survive crashes. Impact results are cached and invalidated incrementally:
// a mutation at lot X only invalidates cached queries rooted at ancestors
// of X, never the whole cache.
class Store {
  constructor(wal) {
    this.wal = wal;
    this.graph = new LineageGraph();
    this.ops = [];
    this.applied = 0;
    this.nextLsn = 1;
    this.impactCache = new Map();
    this.stats = { invalidated: 0, cacheHits: 0 };
  }

  static open(dir) {
    const wal = new Wal(dir);
    const store = new Store(wal);
    const snap = wal.loadSnapshot();
    let baseLsn = 0;
    if (snap) {
      baseLsn = snap.baseLsn;
      store.ops = snap.state.ops;
      store.applied = snap.state.applied;
    }
    for (const rec of wal.replay(baseLsn)) {
      if (rec.type === 'op') {
        store.ops.push(rec.op);
        store.applied = store.ops.length;
      } else if (rec.type === 'undo') {
        store.applied -= 1;
      } else if (rec.type === 'redo') {
        store.applied += 1;
      }
      store.nextLsn = Math.max(store.nextLsn, rec.lsn + 1);
    }
    if (snap) store.nextLsn = Math.max(store.nextLsn, snap.baseLsn + 1);
    store.#rebuild();
    return store;
  }

  #rebuild() {
    this.graph = new LineageGraph();
    for (let i = 0; i < this.applied; i += 1) this.#apply(this.ops[i]);
    this.impactCache.clear();
  }

  #apply(op) {
    if (op.type === 'addLot') this.graph.addLot(op.lot);
    else if (op.type === 'addEdge') this.graph.addEdge(op.edge);
    else if (op.type === 'correctEdge') this.graph.correctEdge(op.edgeId, op.patch);
    else throw new Error(`unknown op ${op.type}`);
  }

  #unapply(op) {
    if (op.type === 'addLot') this.graph.removeLot(op.lot.id);
    else if (op.type === 'addEdge') this.graph.removeEdge(op.edge.id);
    else if (op.type === 'correctEdge') {
      const cur = this.graph.edges.get(op.edgeId);
      this.graph.edges.set(op.edgeId, { ...op.prev });
      void cur;
    } else throw new Error(`unknown op ${op.type}`);
  }

  #commit(record) {
    const lsn = this.nextLsn;
    this.nextLsn += 1;
    this.wal.append(lsn, [record]);
  }

  #invalidateFor(lotIds) {
    const victims = new Set();
    for (const id of lotIds) {
      for (const a of this.graph.ancestorsOf(id)) victims.add(a);
    }
    for (const key of [...this.impactCache.keys()]) {
      if (victims.has(key.split('|')[0])) {
        this.impactCache.delete(key);
        this.stats.invalidated += 1;
      }
    }
  }

  #mutate(op, anchorLotIds) {
    this.#apply(op); // throws (ERR_CYCLE / ERR_CONSERVATION) before any state change
    this.ops.length = this.applied; // drop redo tail on new mutation
    this.ops.push(op);
    this.applied += 1;
    this.#commit({ type: 'op', op });
    this.#invalidateFor(anchorLotIds);
  }

  addLot(lot) {
    this.#mutate({ type: 'addLot', lot }, [lot.id]);
  }

  addEdge(edge) {
    this.#mutate({ type: 'addEdge', edge }, [edge.from]);
  }

  correctEdge(edgeId, patch) {
    const prev = { ...this.graph.edges.get(edgeId) };
    if (!this.graph.edges.has(edgeId)) {
      const err = new Error(`unknown edge ${edgeId}`);
      err.code = 'ERR_EDGE';
      throw err;
    }
    this.#mutate({ type: 'correctEdge', edgeId, patch, prev }, [prev.from]);
  }

  undo() {
    if (this.applied === 0) return false;
    const op = this.ops[this.applied - 1];
    this.#unapply(op);
    this.applied -= 1;
    this.#commit({ type: 'undo' });
    this.#invalidateFor(this.#anchorsOf(op));
    return true;
  }

  redo() {
    if (this.applied >= this.ops.length) return false;
    const op = this.ops[this.applied];
    this.#apply(op);
    this.applied += 1;
    this.#commit({ type: 'redo' });
    this.#invalidateFor(this.#anchorsOf(op));
    return true;
  }

  #anchorsOf(op) {
    if (op.type === 'addLot') return [op.lot.id];
    if (op.type === 'addEdge') return [op.edge.from];
    return [op.prev.from];
  }

  impact(lotId, threshold = 0.5) {
    const key = `${lotId}|${threshold}`;
    const cached = this.impactCache.get(key);
    if (cached) {
      this.stats.cacheHits += 1;
      return cached;
    }
    const result = this.graph.impact(lotId, threshold);
    this.impactCache.set(key, result);
    return result;
  }

  snapshot() {
    const state = {
      ops: this.ops,
      applied: this.applied,
    };
    this.wal.writeSnapshot(this.nextLsn - 1, state);
  }
}

module.exports = { Store };
