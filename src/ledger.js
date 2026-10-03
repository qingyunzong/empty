'use strict';

const { Fraction, TraceError } = require('./fraction');

function cloneState(state) {
  return {
    batches: new Map(
      [...state.batches.entries()].map(([id, b]) => [id, { ...b }])
    ),
    edges: state.edges.map((e) => ({ ...e })),
  };
}

class Ledger {
  constructor() {
    this._transactions = []; // committed transaction log (each: array of ops)
    this._applied = 0;       // how many transactions are currently applied
    this._state = { batches: new Map(), edges: [] };
  }

  // ---- persistence ----
  toJSON() {
    return { applied: this._applied, transactions: this._transactions };
  }
  static fromJSON(data) {
    const ledger = new Ledger();
    ledger._transactions = data.transactions || [];
    ledger._applied = Math.min(data.applied ?? ledger._transactions.length, ledger._transactions.length);
    ledger._recompute();
    return ledger;
  }

  _recompute() {
    const state = { batches: new Map(), edges: [] };
    for (let i = 0; i < this._applied; i++) {
      for (const op of this._transactions[i]) Ledger._applyOp(state, op);
    }
    this._state = state;
  }

  // ---- genealogy helpers ----
  static _forwardReachable(state, fromId) {
    const seen = new Set();
    const stack = [fromId];
    while (stack.length) {
      const id = stack.pop();
      for (const e of state.edges) {
        if (e.from === id && !seen.has(e.to)) {
          seen.add(e.to);
          stack.push(e.to);
        }
      }
    }
    return seen;
  }

  static _assertFreshOutput(state, newId, sources) {
    if (typeof newId !== 'string' || newId.length === 0) {
      throw new TraceError('E_STATE', `invalid batch id: ${String(newId)}`);
    }
    if (!state.batches.has(newId)) return;
    if (sources.includes(newId)) {
      throw new TraceError('E_CYCLE', `output "${newId}" is one of the inputs: self-cycle`);
    }
    const reachable = Ledger._forwardReachable(state, newId);
    if (sources.some((s) => reachable.has(s))) {
      throw new TraceError('E_CYCLE', `reusing "${newId}" as output creates a genealogy cycle`);
    }
    throw new TraceError('E_STATE', `batch id "${newId}" already exists`);
  }

  static _requireLiveBatch(state, id) {
    const b = state.batches.get(id);
    if (!b) throw new TraceError('E_NOTFOUND', `unknown batch: "${id}"`);
    if (b.consumed) throw new TraceError('E_STATE', `batch "${id}" was already consumed`);
    return b;
  }

  // ---- op application (validates then mutates the given state) ----
  static _applyOp(state, op) {
    switch (op.type) {
      case 'create': {
        if (state.batches.has(op.id)) {
          throw new TraceError('E_STATE', `batch id "${op.id}" already exists`);
        }
        const quantity = Fraction.parse(op.quantity);
        if (quantity.sign() < 0) {
          throw new TraceError('E_RATIONAL', `quantity must be non-negative, got ${quantity}`);
        }
        state.batches.set(op.id, { id: op.id, quantity, quarantined: false, consumed: false });
        return;
      }
      case 'split': {
        const parent = Ledger._requireLiveBatch(state, op.id);
        if (!Array.isArray(op.children) || op.children.length === 0) {
          throw new TraceError('E_RATIONAL', 'split requires at least one child');
        }
        const seen = new Set();
        let sum = Fraction.zero();
        const parsed = op.children.map((c) => {
          const ratio = Fraction.parse(c.ratio);
          if (ratio.sign() <= 0) {
            throw new TraceError('E_RATIONAL', `split ratio must be positive, got ${ratio}`);
          }
          if (ratio.cmp(Fraction.one()) > 0) {
            throw new TraceError('E_RATIONAL', `split ratio must not exceed 1, got ${ratio}`);
          }
          if (seen.has(c.id)) throw new TraceError('E_STATE', `duplicate child id "${c.id}"`);
          seen.add(c.id);
          sum = sum.add(ratio);
          return { id: c.id, ratio };
        });
        if (!sum.eq(Fraction.one())) {
          throw new TraceError('E_RATIONAL', `split ratios must sum to exactly 1, got ${sum}`);
        }
        for (const c of parsed) Ledger._assertFreshOutput(state, c.id, [op.id]);
        parent.consumed = true;
        for (const c of parsed) {
          state.batches.set(c.id, {
            id: c.id,
            quantity: parent.quantity.mul(c.ratio),
            quarantined: false,
            consumed: false,
          });
          state.edges.push({ from: op.id, to: c.id, ratio: c.ratio, op: 'split' });
        }
        return;
      }
      case 'join': {
        if (!Array.isArray(op.inputs) || op.inputs.length === 0) {
          throw new TraceError('E_STATE', 'join requires at least one input batch');
        }
        if (new Set(op.inputs).size !== op.inputs.length) {
          throw new TraceError('E_STATE', 'join inputs must be distinct');
        }
        const loss = Fraction.parse(op.loss);
        if (loss.sign() < 0 || loss.cmp(Fraction.one()) > 0) {
          throw new TraceError('E_RATIONAL', `loss rate must be within [0, 1], got ${loss}`);
        }
        const inputs = op.inputs.map((id) => Ledger._requireLiveBatch(state, id));
        Ledger._assertFreshOutput(state, op.output, op.inputs);
        let total = Fraction.zero();
        for (const b of inputs) total = total.add(b.quantity);
        const kept = Fraction.one().sub(loss);
        const outQty = total.mul(kept);
        for (const b of inputs) b.consumed = true;
        state.batches.set(op.output, {
          id: op.output, quantity: outQty, quarantined: false, consumed: false,
        });
        for (const id of op.inputs) {
          state.edges.push({ from: id, to: op.output, ratio: kept, op: 'join' });
        }
        return;
      }
      case 'quarantine': {
        const b = state.batches.get(op.id);
        if (!b) throw new TraceError('E_NOTFOUND', `unknown batch: "${op.id}"`);
        b.quarantined = true;
        return;
      }
      default:
        throw new TraceError('E_STATE', `unknown op type: ${op.type}`);
    }
  }

  // ---- transactions ----
  // fn(tx) runs ops against a working copy; any failure discards everything.
  transact(fn) {
    const working = cloneState(this._state);
    const ops = [];
    const tx = {
      create: (id, quantity) => { const op = { type: 'create', id, quantity: String(quantity) }; Ledger._applyOp(working, op); ops.push(op); },
      split: (id, children) => {
        const op = { type: 'split', id, children: children.map((c) => ({ id: c.id, ratio: String(c.ratio) })) };
        Ledger._applyOp(working, op); ops.push(op);
      },
      join: (inputs, output, loss) => { const op = { type: 'join', inputs: [...inputs], output, loss: String(loss) }; Ledger._applyOp(working, op); ops.push(op); },
      quarantine: (id) => { const op = { type: 'quarantine', id }; Ledger._applyOp(working, op); ops.push(op); },
    };
    fn(tx); // throws -> working copy discarded, ledger untouched (full rollback)
    if (ops.length === 0) return null;
    this._transactions = this._transactions.slice(0, this._applied); // clear redo tail
    this._transactions.push(ops);
    this._applied++;
    this._state = working;
    return ops;
  }

  create(id, quantity) { return this.transact((tx) => tx.create(id, quantity)); }
  split(id, children) { return this.transact((tx) => tx.split(id, children)); }
  join(inputs, output, loss) { return this.transact((tx) => tx.join(inputs, output, loss)); }
  quarantine(id) { return this.transact((tx) => tx.quarantine(id)); }

  undo() {
    if (this._applied === 0) return false;
    this._applied--;
    this._recompute();
    return true;
  }
  redo() {
    if (this._applied >= this._transactions.length) return false;
    this._applied++;
    this._recompute();
    return true;
  }
  get undoDepth() { return this._applied; }
  get redoDepth() { return this._transactions.length - this._applied; }

  // ---- queries ----
  _batch(id) {
    const b = this._state.batches.get(id);
    if (!b) throw new TraceError('E_NOTFOUND', `unknown batch: "${id}"`);
    return b;
  }

  inventory() {
    return [...this._state.batches.values()]
      .filter((b) => !b.consumed)
      .map((b) => ({ id: b.id, quantity: b.quantity, quarantined: b.quarantined }));
  }

  ancestors(id) {
    this._batch(id);
    const result = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of this._state.edges) {
        if (e.to === cur && !result.has(e.from)) { result.add(e.from); stack.push(e.from); }
      }
    }
    return [...result];
  }

  descendants(id) {
    this._batch(id);
    const result = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of this._state.edges) {
        if (e.from === cur && !result.has(e.to)) { result.add(e.to); stack.push(e.to); }
      }
    }
    return [...result];
  }

  // All maximal downward paths starting at `id`, each with the exact
  // cumulative rational ratio (product of edge ratios along the path).
  paths(id) {
    this._batch(id);
    const out = [];
    const walk = (cur, trail, ratio) => {
      const next = this._state.edges.filter((e) => e.from === cur);
      if (next.length === 0) {
        out.push({ path: [...trail], ratio });
        return;
      }
      for (const e of next) walk(e.to, [...trail, e.to], ratio.mul(e.ratio));
    };
    walk(id, [id], Fraction.one());
    return out;
  }

  // All paths from `fromId` to `toId` with cumulative ratios.
  pathsBetween(fromId, toId) {
    this._batch(fromId);
    this._batch(toId);
    const out = [];
    const walk = (cur, trail, ratio, visited) => {
      if (cur === toId) { out.push({ path: [...trail], ratio }); return; }
      for (const e of this._state.edges) {
        if (e.from === cur && !visited.has(e.to)) {
          visited.add(e.to);
          walk(e.to, [...trail, e.to], ratio.mul(e.ratio), visited);
          visited.delete(e.to);
        }
      }
    };
    walk(fromId, [fromId], Fraction.one(), new Set([fromId]));
    return out;
  }

  // Does quarantined batch `qid` pollute output `oid`?
  // Polluted iff qid == oid or qid is an ancestor of oid; the certificate is
  // a concrete path with its exact cumulative ratio.
  pollutes(qid, oid) {
    const q = this._state.batches.get(qid);
    if (!q || !this._state.batches.has(oid)) {
      return { polluted: false, reason: 'unknown batch', certificate: null };
    }
    if (!q.quarantined) {
      return { polluted: false, reason: `batch "${qid}" is not quarantined`, certificate: null };
    }
    const paths = this.pathsBetween(qid, oid);
    if (paths.length === 0) {
      return { polluted: false, reason: 'no genealogy path', certificate: null };
    }
    return { polluted: true, reason: 'quarantined ancestor reaches output', certificate: paths[0], paths };
  }

  quantity(id, decimals = 6) {
    const b = this._batch(id);
    const r = b.quantity.toDecimal(decimals);
    return {
      id,
      exact: r.exact,
      decimal: r.decimal,
      error: r.error.toString(),
      bound: r.bound.toString(),
      withinBound: r.error.cmp(r.bound) <= 0,
      quarantined: b.quarantined,
      consumed: b.consumed,
    };
  }
}

module.exports = { Ledger, Fraction, TraceError };
