import { LineageGraph, TraceError } from './graph.js';
import { Wal } from './wal.js';

export const DEFAULT_THRESHOLD = 0.05;

function actionFor(lot) {
  if (lot.frozen) return 'keep-frozen';
  switch (lot.kind) {
    case 'customer_order': return 'recall';
    case 'in_transit': return 'halt-shipment';
    case 'finished': return 'freeze';
    default: return 'hold';
  }
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Store = LineageGraph + WAL-backed undo/redo journal + incremental
// probability cache. Every mutation is committed as one WAL transaction
// carrying both the op and its inverse; undo/redo are themselves WAL
// records, so the undo history survives process crashes.
export class Store {
  static open(dir) {
    const wal = new Wal(dir);
    const store = new Store(wal);
    for (const rec of wal.records) store._applyRecord(rec);
    return store;
  }

  constructor(wal) {
    this.wal = wal;
    this.graph = new LineageGraph();
    this.undoStack = [];
    this.redoStack = [];
    this.cache = new Map(); // sourceLot -> { probs: Map }
    this.stats = { recomputed: 0, fullComputes: 0 };
  }

  _applyRecord(rec) {
    if (rec.kind === 'tx') {
      this._applyOp(rec.op);
      this.undoStack.push(rec);
      this.redoStack = [];
    } else if (rec.kind === 'undo') {
      const tx = this.undoStack.pop();
      if (!tx || tx.txId !== rec.ref) throw new TraceError('ERR_WAL', 'undo journal mismatch');
      this._applyOp(tx.inverse);
      this.redoStack.push(tx);
    } else if (rec.kind === 'redo') {
      const tx = this.redoStack.pop();
      if (!tx || tx.txId !== rec.ref) throw new TraceError('ERR_WAL', 'redo journal mismatch');
      this._applyOp(tx.op);
      this.undoStack.push(tx);
    }
  }

  _applyOp(op) {
    switch (op.type) {
      case 'addLot':
        this.graph.addLot(op.lot);
        break;
      case 'removeLot':
        this.graph.removeLot(op.lotId);
        this.cache.clear();
        break;
      case 'addEdge': {
        this.graph.addEdge(op.edge);
        this._invalidate(op.edge.from, this.graph.descendants(op.edge.to));
        break;
      }
      case 'removeEdge': {
        const e = this.graph.edges.get(op.edgeId);
        const pre = this.graph.descendants(e.to);
        this.graph.removeEdge(op.edgeId);
        this._invalidate(e.from, pre);
        break;
      }
      case 'correct': {
        this.graph.correctEdge(op.edgeId, op.patch);
        const e = this.graph.edges.get(op.edgeId);
        this._invalidate(e.from, this.graph.descendants(e.to));
        break;
      }
      default:
        throw new TraceError('ERR_OP', `unknown op ${op.type}`);
    }
  }

  // Incremental maintenance: only cache entries whose source can reach the
  // changed edge are touched, and within them only the downstream cone of
  // the edge target is recomputed (parents outside keep cached values).
  _invalidate(changedFrom, affectedScope) {
    for (const [source, entry] of this.cache) {
      if (!entry.probs.has(changedFrom)) continue;
      this.graph.computeProbs(source, affectedScope, entry.probs);
      this.stats.recomputed += affectedScope.size;
    }
  }

  _commit(op, inverse) {
    this._applyOp(op); // validates first: invalid ops never reach the WAL
    let rec;
    try {
      const txId = this.wal.append({ kind: 'tx', op, inverse });
      rec = { kind: 'tx', txId, op, inverse };
    } catch (err) {
      this._applyOp(inverse); // roll back in-memory state if the WAL write fails
      throw err;
    }
    this.undoStack.push(rec);
    this.redoStack = [];
    return rec;
  }

  addLot(lot) {
    this._commit({ type: 'addLot', lot }, { type: 'removeLot', lotId: lot.id });
    return { ok: true, lot: this.graph.lots.get(lot.id) };
  }

  addEdge(edge) {
    this._commit({ type: 'addEdge', edge }, { type: 'removeEdge', edgeId: edge.id });
    return { ok: true, edge: this.graph.edges.get(edge.id) };
  }

  correct(edgeId, patch) {
    const e = this.graph.edges.get(edgeId);
    if (!e) throw new TraceError('ERR_NO_EDGE', `edge ${edgeId} not found`);
    this._commit(
      { type: 'correct', edgeId, patch },
      { type: 'correct', edgeId, patch: { qty: e.qty } },
    );
    return { ok: true, edge: this.graph.edges.get(edgeId) };
  }

  undo() {
    const tx = this.undoStack.pop();
    if (!tx) return { undone: false };
    this._applyOp(tx.inverse);
    this.wal.append({ kind: 'undo', ref: tx.txId });
    this.redoStack.push(tx);
    return { undone: true, txId: tx.txId };
  }

  redo() {
    const tx = this.redoStack.pop();
    if (!tx) return { redone: false };
    this._applyOp(tx.op);
    this.wal.append({ kind: 'redo', ref: tx.txId });
    this.undoStack.push(tx);
    return { redone: true, txId: tx.txId };
  }

  impact(sourceId, threshold = DEFAULT_THRESHOLD) {
    let entry = this.cache.get(sourceId);
    if (!entry) {
      entry = { probs: new Map() };
      this.graph.computeProbs(sourceId, this.graph.descendants(sourceId), entry.probs);
      this.cache.set(sourceId, entry);
      this.stats.fullComputes += 1;
    }
    return this._impactResult(sourceId, entry.probs, threshold);
  }

  // Reference path: always recomputes the whole descendant cone from scratch.
  impactFull(sourceId, threshold = DEFAULT_THRESHOLD) {
    const probs = new Map();
    this.graph.computeProbs(sourceId, this.graph.descendants(sourceId), probs);
    return this._impactResult(sourceId, probs, threshold);
  }

  _impactResult(sourceId, probs, threshold) {
    if (!this.graph.lots.has(sourceId)) throw new TraceError('ERR_NO_LOT', `lot ${sourceId} not found`);
    const affected = [];
    for (const [id, p] of probs) {
      if (p > 0 && p >= threshold) {
        const lot = this.graph.lots.get(id);
        affected.push({ lot: id, kind: lot.kind, prob: p, action: actionFor(lot) });
      }
    }
    affected.sort((a, b) => (a.lot < b.lot ? -1 : 1));
    const witnessMap = this.graph.witnesses(sourceId, this.graph.descendants(sourceId));
    const certificate = affected.map((a) => {
      const w = witnessMap.get(a.lot) ?? { prob: 1, path: [a.lot] };
      return { lot: a.lot, prob: a.prob, pathProb: w.prob, witness: w.path };
    });
    const check = this.verifyCertificate(sourceId, threshold, affected.map((a) => a.lot));
    const groups = {};
    for (const a of affected) (groups[a.kind] ??= []).push(a.lot);
    return {
      source: sourceId,
      threshold,
      affected,
      groups,
      certificate,
      minimal: check.satisfied && check.minimal,
    };
  }

  // A recall set satisfies the rules iff it contains exactly the lots whose
  // propagation probability reaches the threshold (under freeze containment).
  // It is minimal iff removing any single listed lot breaks satisfaction.
  verifyCertificate(sourceId, threshold, listed) {
    const probs = new Map();
    this.graph.computeProbs(sourceId, this.graph.descendants(sourceId), probs);
    const expected = new Set();
    for (const [id, p] of probs) if (p > 0 && p >= threshold) expected.add(id);
    const listedSet = new Set(listed);
    const missing = [...expected].filter((x) => !listedSet.has(x));
    const extraneous = [...listedSet].filter((x) => !expected.has(x));
    return {
      satisfied: missing.length === 0 && extraneous.length === 0,
      minimal: extraneous.length === 0 && listed.length === listedSet.size,
      missing,
      extraneous,
    };
  }

  snapshot() {
    return {
      lots: [...this.graph.lots.values()].sort(byId),
      edges: [...this.graph.edges.values()].sort(byId),
      conservation: this.graph.checkConservation(),
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
    };
  }
}
