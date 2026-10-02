import { canonical, hashSnapshot, comparePath } from './canonical.js';

export const E_CYCLE = 'E_CYCLE';
export const E_REF = 'E_REF';
export const E_DUP = 'E_DUP';
export const E_UNDO = 'E_UNDO';

export class LabError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function byId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Incremental experiment-validity engine.
 *
 * Batches: { id, concentration, expiry (epoch ms | null), withdrawn, corrected }.
 * A batch is invalid when withdrawn, concentration-corrected, or expiry <= now.
 *
 * Nodes: results (kind 'result', with batchId + protocol + substitute edges),
 * charts and conclusions (derived nodes with dependency edges).
 *
 * A result is valid iff its protocol is non-empty and at least one candidate
 * batch (primary + substitutes) is valid; the chosen batch is the valid
 * candidate with the lexicographically smallest id. A derived node is valid
 * iff every dependency is valid. Invalidation propagates along dependents.
 */
export class Engine {
  constructor({ now = 0 } = {}) {
    this.now = now;
    this.batches = new Map();
    this.nodes = new Map();
    this.substitutes = new Map(); // resultId -> Set<batchId>
    this.dependents = new Map(); // nodeId -> Set<nodeId>
    this.computed = new Map(); // nodeId -> { status, reason, chosen, path }
    this.undoStack = [];
    this.redoStack = [];
    this._lastAffected = [];
  }

  // ---------- public API (each returns { ok, value } | { ok:false, error }) ----------

  addBatch({ id, concentration = null, expiry = null }) {
    return this._handle(() => {
      this._requireNewId(id, 'batch');
      this._checkpoint();
      this.batches.set(id, { id, concentration, expiry, withdrawn: false, corrected: false });
      this._lastAffected = [];
      return { id };
    });
  }

  withdrawBatch(id) {
    return this._handle(() => {
      const batch = this._requireBatch(id);
      this._checkpoint();
      batch.withdrawn = true;
      this._recompute(this._resultsUsing(id));
      return { id };
    });
  }

  correctConcentration(id, concentration) {
    return this._handle(() => {
      const batch = this._requireBatch(id);
      this._checkpoint();
      batch.corrected = true;
      batch.concentration = concentration;
      this._recompute(this._resultsUsing(id));
      return { id };
    });
  }

  setExpiry(id, expiry) {
    return this._handle(() => {
      const batch = this._requireBatch(id);
      this._checkpoint();
      batch.expiry = expiry;
      this._recompute(this._resultsUsing(id));
      return { id };
    });
  }

  addResult({ id, batch, protocol, deps = [] }) {
    return this._handle(() => {
      this._requireNewId(id, 'node');
      this._requireBatch(batch);
      for (const dep of deps) this._requireNode(dep);
      this._checkpoint();
      this.nodes.set(id, { id, kind: 'result', batchId: batch, protocol, deps: [...new Set(deps)] });
      this.substitutes.set(id, new Set());
      this._linkDeps(id);
      this._recompute([id]);
      return { id };
    });
  }

  addNode({ id, kind, deps = [] }) {
    return this._handle(() => {
      if (kind !== 'chart' && kind !== 'conclusion') {
        throw new LabError(E_REF, `unknown node kind: ${kind}`);
      }
      this._requireNewId(id, 'node');
      for (const dep of deps) this._requireNode(dep);
      this._checkpoint();
      this.nodes.set(id, { id, kind, batchId: null, protocol: null, deps: [...new Set(deps)] });
      this._linkDeps(id);
      this._recompute([id]);
      return { id };
    });
  }

  addEdge(node, dependsOn) {
    return this._handle(() => {
      const record = this._requireNode(node);
      this._requireNode(dependsOn);
      if (node === dependsOn || this._reaches(dependsOn, node)) {
        throw new LabError(E_CYCLE, `edge ${node} -> ${dependsOn} closes a cycle`);
      }
      if (record.deps.includes(dependsOn)) return { node, dependsOn, added: false };
      this._checkpoint();
      record.deps.push(dependsOn);
      this.dependents.get(dependsOn).add(node);
      this._recompute([node]);
      return { node, dependsOn, added: true };
    });
  }

  addSubstitute(result, batch) {
    return this._handle(() => {
      this._requireResult(result);
      this._requireBatch(batch);
      this._checkpoint();
      this.substitutes.get(result).add(batch);
      this._recompute([result]);
      return { result, batch };
    });
  }

  removeSubstitute(result, batch) {
    return this._handle(() => {
      this._requireResult(result);
      this._requireBatch(batch);
      this._checkpoint();
      this.substitutes.get(result).delete(batch);
      this._recompute([result]);
      return { result, batch };
    });
  }

  undo() {
    return this._handle(() => {
      if (this.undoStack.length === 0) throw new LabError(E_UNDO, 'nothing to undo');
      this.redoStack.push(this._serialize());
      this._restore(this.undoStack.pop());
      return { undone: true };
    });
  }

  redo() {
    return this._handle(() => {
      if (this.redoStack.length === 0) throw new LabError(E_UNDO, 'nothing to redo');
      this.undoStack.push(this._serialize());
      this._restore(this.redoStack.pop());
      return { redone: true };
    });
  }

  status(id) {
    return this._handle(() => {
      this._requireNode(id);
      const c = this.computed.get(id);
      return {
        id,
        status: c.status,
        reason: c.reason,
        chosenBatch: c.chosen,
        invalidationPath: c.path,
      };
    });
  }

  certificate(id) {
    return this._handle(() => {
      const node = this._requireNode(id);
      const c = this.computed.get(id);
      const cert = {
        node: id,
        kind: node.kind,
        status: c.status,
        chosenBatch: c.chosen,
        invalidationPath: c.path,
        stateHash: this.stateHash(),
      };
      if (node.kind !== 'result') {
        const choices = {};
        for (const rid of this._resultCone(id)) choices[rid] = this.computed.get(rid).chosen;
        cert.choices = choices;
      }
      return cert;
    });
  }

  stateHash() {
    return hashSnapshot(this.snapshot());
  }

  snapshot() {
    return {
      batches: [...this.batches.values()]
        .map((b) => ({ id: b.id, concentration: b.concentration, expiry: b.expiry, withdrawn: b.withdrawn, corrected: b.corrected }))
        .sort((a, b) => byId(a.id, b.id)),
      nodes: [...this.nodes.values()]
        .map((n) => ({ id: n.id, kind: n.kind, batch: n.batchId, protocol: n.protocol, deps: [...n.deps].sort() }))
        .sort((a, b) => byId(a.id, b.id)),
      substitutes: [...this.substitutes.entries()]
        .map(([result, set]) => ({ result, batches: [...set].sort() }))
        .sort((a, b) => byId(a.result, b.result)),
      computed: [...this.computed.entries()]
        .map(([node, c]) => ({ node, status: c.status, reason: c.reason, chosen: c.chosen, path: c.path }))
        .sort((a, b) => byId(a.node, b.node)),
    };
  }

  /** Ids of nodes re-evaluated by the most recent mutation (sorted). */
  lastAffected() {
    return [...this._lastAffected];
  }

  // ---------- internals ----------

  _handle(fn) {
    try {
      return { ok: true, value: fn() };
    } catch (err) {
      if (err instanceof LabError) return { ok: false, error: { code: err.code, message: err.message } };
      throw err;
    }
  }

  _requireBatch(id) {
    const batch = this.batches.get(id);
    if (!batch) throw new LabError(E_REF, `unknown batch: ${id}`);
    return batch;
  }

  _requireNode(id) {
    const node = this.nodes.get(id);
    if (!node) throw new LabError(E_REF, `unknown node: ${id}`);
    return node;
  }

  _requireResult(id) {
    const node = this._requireNode(id);
    if (node.kind !== 'result') throw new LabError(E_REF, `not a result node: ${id}`);
    return node;
  }

  _requireNewId(id, what) {
    if (typeof id !== 'string' || id.length === 0) throw new LabError(E_REF, `invalid ${what} id`);
    if (this.batches.has(id) || this.nodes.has(id)) throw new LabError(E_DUP, `duplicate id: ${id}`);
  }

  _batchInfo(id) {
    const b = this.batches.get(id);
    if (b.withdrawn) return { valid: false, reason: 'withdrawn' };
    if (b.corrected) return { valid: false, reason: 'concentration_corrected' };
    if (b.expiry !== null && b.expiry <= this.now) return { valid: false, reason: 'expired' };
    return { valid: true, reason: null };
  }

  _candidates(resultId) {
    const node = this.nodes.get(resultId);
    const all = new Set([node.batchId, ...(this.substitutes.get(resultId) ?? [])]);
    return [...all].sort();
  }

  _resultsUsing(batchId) {
    const seeds = [];
    for (const [id, node] of this.nodes) {
      if (node.kind !== 'result') continue;
      if (node.batchId === batchId || (this.substitutes.get(id) ?? new Set()).has(batchId)) seeds.push(id);
    }
    return seeds;
  }

  _linkDeps(id) {
    const node = this.nodes.get(id);
    if (!this.dependents.has(id)) this.dependents.set(id, new Set());
    for (const dep of node.deps) {
      if (!this.dependents.has(dep)) this.dependents.set(dep, new Set());
      this.dependents.get(dep).add(id);
    }
  }

  _reaches(from, target) {
    const seen = new Set();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = this.nodes.get(id);
      if (node) stack.push(...node.deps);
    }
    return false;
  }

  _closure(seeds) {
    const out = new Set(seeds);
    const stack = [...seeds];
    while (stack.length > 0) {
      const id = stack.pop();
      for (const dependent of this.dependents.get(id) ?? []) {
        if (!out.has(dependent)) {
          out.add(dependent);
          stack.push(dependent);
        }
      }
    }
    return out;
  }

  _orderWithin(closure) {
    const order = [];
    const done = new Set();
    const active = new Set();
    const visit = (id) => {
      if (done.has(id)) return;
      if (active.has(id)) throw new LabError(E_CYCLE, `dependency cycle through ${id}`);
      active.add(id);
      for (const dep of this.nodes.get(id).deps) if (closure.has(dep)) visit(dep);
      active.delete(id);
      done.add(id);
      order.push(id);
    };
    for (const id of closure) visit(id);
    return order;
  }

  _eval(id) {
    const node = this.nodes.get(id);
    if (node.kind === 'result') {
      if (!node.protocol) {
        return { status: 'invalid', reason: 'empty_protocol', chosen: null, path: [id] };
      }
      const candidates = this._candidates(id);
      for (const cand of candidates) {
        if (this._batchInfo(cand).valid) {
          return { status: 'valid', reason: null, chosen: cand, path: null };
        }
      }
      const cause = candidates[0];
      return { status: 'invalid', reason: this._batchInfo(cause).reason, chosen: null, path: [cause, id] };
    }
    let best = null;
    for (const dep of node.deps) {
      const c = this.computed.get(dep);
      if (c && c.status === 'invalid') {
        const path = [...c.path, id];
        if (best === null || comparePath(path, best) < 0) best = path;
      }
    }
    if (best) return { status: 'invalid', reason: 'dependency_invalid', chosen: null, path: best };
    return { status: 'valid', reason: null, chosen: null, path: null };
  }

  _recompute(seeds) {
    const closure = this._closure(seeds);
    for (const id of this._orderWithin(closure)) this.computed.set(id, this._eval(id));
    this._lastAffected = [...closure].sort();
  }

  _recomputeAll() {
    this.computed = new Map();
    this._recompute([...this.nodes.keys()]);
  }

  _resultCone(id) {
    const out = [];
    const seen = new Set();
    const visit = (nid) => {
      if (seen.has(nid)) return;
      seen.add(nid);
      const node = this.nodes.get(nid);
      if (node.kind === 'result') out.push(nid);
      for (const dep of node.deps) visit(dep);
    };
    visit(id);
    return out.sort();
  }

  _checkpoint() {
    this.undoStack.push(this._serialize());
    this.redoStack = [];
  }

  _serialize() {
    return JSON.stringify({
      batches: [...this.batches.values()],
      nodes: [...this.nodes.values()].map((n) => ({ ...n, deps: [...n.deps] })),
      substitutes: [...this.substitutes.entries()].map(([k, v]) => [k, [...v]]),
    });
  }

  _restore(payload) {
    const data = JSON.parse(payload);
    this.batches = new Map(data.batches.map((b) => [b.id, { ...b }]));
    this.nodes = new Map(data.nodes.map((n) => [n.id, { ...n, deps: [...n.deps] }]));
    this.substitutes = new Map(data.substitutes.map(([k, v]) => [k, new Set(v)]));
    this.dependents = new Map();
    for (const id of this.nodes.keys()) this._linkDeps(id);
    this._recomputeAll();
  }
}

export { canonical, hashSnapshot };
