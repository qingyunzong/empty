import { Rational } from './rational.js';
import { TraceError } from './errors.js';

function assertId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TraceError('E_ARG', `invalid batch id: ${JSON.stringify(id)}`);
  }
}

export class Ledger {
  constructor() {
    this.batches = new Map(); // id -> { id, quantity: Rational, quarantined: boolean }
    this.edges = [];          // { from, to, ratio: Rational }
    this.undoStack = [];      // committed transactions: [ [ {fwd, inv}, ... ], ... ]
    this.redoStack = [];
  }

  begin() { return new Transaction(this); }

  _single(fn) {
    const tx = this.begin();
    fn(tx);
    tx.commit();
  }

  create(id, quantity) { this._single((tx) => tx.create(id, quantity)); }
  split(id, ratios, childIds) { this._single((tx) => tx.split(id, ratios, childIds)); }
  join(inputIds, outputId, lossRate) { this._single((tx) => tx.join(inputIds, outputId, lossRate)); }
  quarantine(id) { this._single((tx) => tx.quarantine(id)); }

  // --- primitive mutations (journalled) ---

  _mutate(m) {
    switch (m.type) {
      case 'addBatch': {
        this.batches.set(m.id, {
          id: m.id,
          quantity: Rational.parse(m.quantity),
          quarantined: !!m.quarantined,
        });
        return { type: 'removeBatch', id: m.id };
      }
      case 'removeBatch': {
        const b = this._batch(m.id);
        this.batches.delete(m.id);
        return { type: 'addBatch', id: b.id, quantity: b.quantity.toString(), quarantined: b.quarantined };
      }
      case 'addEdge': {
        const ratio = Rational.parse(m.ratio);
        this.edges.push({ from: m.from, to: m.to, ratio });
        return { type: 'removeEdge', from: m.from, to: m.to, ratio: ratio.toString() };
      }
      case 'removeEdge': {
        const want = Rational.parse(m.ratio).toString();
        const i = this.edges.findIndex(
          (e) => e.from === m.from && e.to === m.to && e.ratio.toString() === want,
        );
        if (i < 0) throw new TraceError('E_STATE', `edge not found: ${m.from} -> ${m.to}`);
        const [e] = this.edges.splice(i, 1);
        return { type: 'addEdge', from: e.from, to: e.to, ratio: e.ratio.toString() };
      }
      case 'setQuarantine': {
        const b = this._batch(m.id);
        const prev = b.quarantined;
        b.quarantined = !!m.value;
        return { type: 'setQuarantine', id: m.id, value: prev };
      }
      default:
        throw new TraceError('E_STATE', `unknown mutation type: ${m.type}`);
    }
  }

  _commitTx(entries) {
    if (entries.length > 0) {
      this.undoStack.push(entries);
      this.redoStack.length = 0;
    }
  }

  undo() {
    const tx = this.undoStack.pop();
    if (!tx) return false;
    for (let i = tx.length - 1; i >= 0; i--) this._mutate(tx[i].inv);
    this.redoStack.push(tx);
    return true;
  }

  redo() {
    const tx = this.redoStack.pop();
    if (!tx) return false;
    for (const e of tx) this._mutate(e.fwd);
    this.undoStack.push(tx);
    return true;
  }

  // --- lookups ---

  _batch(id) {
    const b = this.batches.get(id);
    if (!b) throw new TraceError('E_NOT_FOUND', `unknown batch: ${id}`);
    return b;
  }

  getBatch(id) {
    const b = this._batch(id);
    return { id: b.id, quantity: b.quantity, quarantined: b.quarantined };
  }

  inventory() {
    return [...this.batches.values()]
      .map((b) => ({ id: b.id, quantity: b.quantity.toString(), quarantined: b.quarantined }))
      .sort((a, b2) => (a.id < b2.id ? -1 : a.id > b2.id ? 1 : 0));
  }

  _adjacency() {
    const adj = new Map();
    for (const e of this.edges) {
      if (!adj.has(e.from)) adj.set(e.from, []);
      adj.get(e.from).push(e);
    }
    return adj;
  }

  _reaches(from, to) {
    const adj = this._adjacency();
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
      const node = queue.shift();
      for (const e of adj.get(node) || []) {
        if (e.to === to) return true;
        if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
      }
    }
    return false;
  }

  ancestors(id) {
    this._batch(id);
    const rev = new Map();
    for (const e of this.edges) {
      if (!rev.has(e.to)) rev.set(e.to, []);
      rev.get(e.to).push(e.from);
    }
    const seen = new Set();
    const queue = [id];
    while (queue.length > 0) {
      const node = queue.shift();
      for (const p of rev.get(node) || []) {
        if (!seen.has(p)) { seen.add(p); queue.push(p); }
      }
    }
    return [...seen].sort();
  }

  descendants(id) {
    this._batch(id);
    const adj = this._adjacency();
    const seen = new Set();
    const queue = [id];
    while (queue.length > 0) {
      const node = queue.shift();
      for (const e of adj.get(node) || []) {
        if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
      }
    }
    return [...seen].sort();
  }

  // Enumerate every path from -> to with the cumulative rational ratio of each.
  pathRatios(from, to) {
    this._batch(from);
    this._batch(to);
    const adj = this._adjacency();
    const paths = [];
    const dfs = (node, acc, ratio, visited) => {
      if (node === to) {
        paths.push({ path: [...acc], ratio });
        return;
      }
      for (const e of adj.get(node) || []) {
        if (visited.has(e.to)) {
          throw new TraceError('E_CYCLE', `cycle detected at batch ${e.to}`);
        }
        visited.add(e.to);
        acc.push(e.to);
        dfs(e.to, acc, ratio.mul(e.ratio), visited);
        acc.pop();
        visited.delete(e.to);
      }
    };
    dfs(from, [from], Rational.ONE, new Set([from]));
    const total = paths.reduce((a, p) => a.add(p.ratio), Rational.ZERO);
    return { from, to, paths, total };
  }

  // Contamination certificates: every quarantined batch that reaches `outputId`,
  // with the paths (and cumulative ratios) through which it contaminates.
  contamination(outputId) {
    this._batch(outputId);
    const result = [];
    for (const [id, b] of this.batches) {
      if (!b.quarantined) continue;
      if (id === outputId) {
        result.push({ quarantined: id, paths: [{ path: [id], ratio: Rational.ONE }], total: Rational.ONE });
      } else if (this._reaches(id, outputId)) {
        const pr = this.pathRatios(id, outputId);
        result.push({ quarantined: id, paths: pr.paths, total: pr.total });
      }
    }
    return result;
  }

  contaminates(quarantinedId, outputId) {
    const q = this._batch(quarantinedId);
    this._batch(outputId);
    if (!q.quarantined) return false;
    return quarantinedId === outputId || this._reaches(quarantinedId, outputId);
  }

  // --- persistence ---

  toJSON() {
    return {
      batches: [...this.batches.values()].map((b) => ({
        id: b.id,
        quantity: b.quantity.toString(),
        quarantined: b.quarantined,
      })),
      edges: this.edges.map((e) => ({ from: e.from, to: e.to, ratio: e.ratio.toString() })),
      undoStack: this.undoStack,
      redoStack: this.redoStack,
    };
  }

  static fromJSON(data) {
    const ledger = new Ledger();
    for (const b of data.batches || []) {
      ledger._mutate({ type: 'addBatch', id: b.id, quantity: b.quantity, quarantined: b.quarantined });
    }
    for (const e of data.edges || []) {
      ledger._mutate({ type: 'addEdge', from: e.from, to: e.to, ratio: e.ratio });
    }
    ledger.undoStack = data.undoStack || [];
    ledger.redoStack = data.redoStack || [];
    return ledger;
  }
}

export class Transaction {
  constructor(ledger) {
    this.ledger = ledger;
    this.entries = []; // { fwd, inv }
    this.active = true;
  }

  _assertActive() {
    if (!this.active) throw new TraceError('E_STATE', 'transaction is closed');
  }

  _mutate(m) {
    const inv = this.ledger._mutate(m);
    this.entries.push({ fwd: m, inv });
  }

  _guard(fn) {
    this._assertActive();
    try {
      return fn();
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  create(id, quantity) {
    return this._guard(() => {
      assertId(id);
      if (this.ledger.batches.has(id)) throw new TraceError('E_EXISTS', `batch already exists: ${id}`);
      const q = Rational.parse(quantity);
      if (q.sign() < 0) throw new TraceError('E_RATIONAL', `quantity must be >= 0, got ${q}`);
      this._mutate({ type: 'addBatch', id, quantity: q.toString(), quarantined: false });
      return id;
    });
  }

  split(id, ratios, childIds) {
    return this._guard(() => {
      const parent = this.ledger._batch(id);
      if (!Array.isArray(ratios) || ratios.length === 0) {
        throw new TraceError('E_RATIONAL', 'split requires a non-empty ratio list');
      }
      const rs = ratios.map((r) => {
        const q = Rational.parse(r);
        if (q.sign() <= 0) throw new TraceError('E_RATIONAL', `split ratio must be positive, got ${q}`);
        return q;
      });
      const sum = rs.reduce((a, b) => a.add(b), Rational.ZERO);
      if (sum.cmp(Rational.ONE) !== 0) {
        throw new TraceError('E_RATIONAL', `split ratios must sum to exactly 1, got ${sum}`);
      }
      if (!Array.isArray(childIds) || childIds.length !== rs.length) {
        throw new TraceError('E_ARG', 'childIds must match the number of ratios');
      }
      const seen = new Set();
      for (const c of childIds) {
        assertId(c);
        if (seen.has(c)) throw new TraceError('E_EXISTS', `duplicate child id: ${c}`);
        if (this.ledger.batches.has(c)) throw new TraceError('E_EXISTS', `batch already exists: ${c}`);
        seen.add(c);
      }
      rs.forEach((r, i) => {
        const c = childIds[i];
        this._mutate({ type: 'addBatch', id: c, quantity: parent.quantity.mul(r).toString(), quarantined: false });
        this._mutate({ type: 'addEdge', from: id, to: c, ratio: r.toString() });
      });
      return childIds;
    });
  }

  join(inputIds, outputId, lossRate) {
    return this._guard(() => {
      assertId(outputId);
      if (!Array.isArray(inputIds) || inputIds.length === 0) {
        throw new TraceError('E_ARG', 'join requires a non-empty input list');
      }
      const inputs = inputIds.map((i) => this.ledger._batch(i));
      const loss = Rational.parse(lossRate);
      if (loss.sign() < 0 || loss.cmp(Rational.ONE) >= 0) {
        throw new TraceError('E_RATIONAL', `loss rate must be in [0, 1), got ${loss}`);
      }
      for (const inp of inputIds) {
        if (inp === outputId) {
          throw new TraceError('E_CYCLE', `join output ${outputId} is also an input`);
        }
        if (this.ledger.batches.has(outputId) && this.ledger._reaches(outputId, inp)) {
          throw new TraceError('E_CYCLE', `joining ${inp} into ${outputId} would create a genealogy cycle`);
        }
      }
      const keep = Rational.ONE.sub(loss);
      const total = inputs.reduce((a, b) => a.add(b.quantity), Rational.ZERO).mul(keep);
      const existing = this.ledger.batches.get(outputId);
      if (existing) {
        this._mutate({ type: 'removeBatch', id: outputId });
        this._mutate({
          type: 'addBatch',
          id: outputId,
          quantity: existing.quantity.add(total).toString(),
          quarantined: existing.quarantined,
        });
      } else {
        this._mutate({ type: 'addBatch', id: outputId, quantity: total.toString(), quarantined: false });
      }
      for (const inp of inputIds) {
        this._mutate({ type: 'addEdge', from: inp, to: outputId, ratio: keep.toString() });
      }
      return outputId;
    });
  }

  quarantine(id) {
    return this._guard(() => {
      this.ledger._batch(id);
      this._mutate({ type: 'setQuarantine', id, value: true });
      return id;
    });
  }

  commit() {
    this._assertActive();
    this.active = false;
    this.ledger._commitTx(this.entries);
  }

  rollback() {
    if (!this.active) return;
    this.active = false;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      this.ledger._mutate(this.entries[i].inv);
    }
  }
}
