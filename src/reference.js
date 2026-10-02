// Brute-force reference implementation used for differential testing.
// Every evaluation recomputes from scratch by enumerating ALL substitute
// paths and ALL cause->node invalidation paths, then picking the
// deterministic (lexicographically smallest) outcome.

function cmpPath(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export function refCreateState() {
  return { batches: new Map(), nodes: new Map(), subs: new Map() };
}

export function refBatchValid(batch, now) {
  if (batch.withdrawn) return { valid: false, reason: 'withdrawn' };
  if (batch.corrected) return { valid: false, reason: 'concentration_corrected' };
  if (batch.expiry !== null && batch.expiry <= now) return { valid: false, reason: 'expired' };
  return { valid: true, reason: null };
}

function enumerateResultPaths(state, resultId) {
  // Every substitute path of a result: [candidateBatchId, resultId].
  const node = state.nodes.get(resultId);
  const cands = new Set([node.batchId, ...(state.subs.get(resultId) ?? [])]);
  return [...cands].sort().map((cand) => [cand, resultId]);
}

function enumerateInvalidPaths(state, now, nodeId, memo, visiting) {
  // All cause -> node invalidation paths for a node, by full enumeration.
  if (memo.has(nodeId)) return memo.get(nodeId);
  if (visiting.has(nodeId)) return []; // cycle guard; cycles are rejected at insertion
  visiting.add(nodeId);
  const node = state.nodes.get(nodeId);
  let paths = [];
  if (node.kind === 'result') {
    if (!node.protocol) {
      paths = [[nodeId]];
    } else {
      // A result is invalid only when EVERY substitute path ends at an
      // invalid batch; a single valid candidate means no invalidation path.
      const cands = [...new Set([node.batchId, ...(state.subs.get(nodeId) ?? [])])];
      const anyValid = cands.some((cand) => refBatchValid(state.batches.get(cand), now).valid);
      if (anyValid) {
        memo.set(nodeId, []);
        visiting.delete(nodeId);
        return [];
      }
      for (const p of enumerateResultPaths(state, nodeId)) {
        const info = refBatchValid(state.batches.get(p[0]), now);
        if (!info.valid) paths.push(p);
      }
    }
  } else {
    for (const dep of node.deps) {
      for (const sub of enumerateInvalidPaths(state, now, dep, memo, visiting)) {
        paths.push([...sub, nodeId]);
      }
    }
  }
  visiting.delete(nodeId);
  memo.set(nodeId, paths);
  return paths;
}

export function refEvaluate(state, now) {
  const computed = new Map();
  // Topological order via iterative DFS (guards against cycles).
  const order = [];
  const done = new Set();
  const active = new Set();
  const visit = (id) => {
    if (done.has(id)) return;
    if (active.has(id)) throw new Error('E_CYCLE');
    active.add(id);
    for (const dep of state.nodes.get(id).deps) if (state.nodes.has(dep)) visit(dep);
    active.delete(id);
    done.add(id);
    order.push(id);
  };
  for (const id of state.nodes.keys()) visit(id);

  const memo = new Map();
  for (const id of order) {
    const node = state.nodes.get(id);
    if (node.kind === 'result') {
      if (!node.protocol) {
        computed.set(id, { status: 'invalid', reason: 'empty_protocol', chosen: null, path: [id] });
        continue;
      }
      // Enumerate every substitute path; the result is valid iff at least one
      // path ends at a valid batch. Chosen batch = smallest valid candidate id.
      const paths = enumerateResultPaths(state, id);
      const validCands = paths
        .map((p) => p[0])
        .filter((cand) => refBatchValid(state.batches.get(cand), now).valid)
        .sort();
      if (validCands.length > 0) {
        computed.set(id, { status: 'valid', reason: null, chosen: validCands[0], path: null });
      } else {
        const invalidPaths = enumerateInvalidPaths(state, now, id, memo, new Set());
        invalidPaths.sort(cmpPath);
        const best = invalidPaths[0];
        const cause = best[0];
        computed.set(id, {
          status: 'invalid',
          reason: refBatchValid(state.batches.get(cause), now).reason,
          chosen: null,
          path: best,
        });
      }
    } else {
      const invalidPaths = enumerateInvalidPaths(state, now, id, memo, new Set());
      if (invalidPaths.length === 0) {
        computed.set(id, { status: 'valid', reason: null, chosen: null, path: null });
      } else {
        invalidPaths.sort(cmpPath);
        computed.set(id, { status: 'invalid', reason: 'dependency_invalid', chosen: null, path: invalidPaths[0] });
      }
    }
  }
  return computed;
}

// Reachability check used to mirror the engine's E_CYCLE rejection.
export function refWouldCycle(state, node, dependsOn) {
  const seen = new Set();
  const stack = [dependsOn];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === node) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = state.nodes.get(id);
    if (n) stack.push(...n.deps);
  }
  return false;
}

// Stateful wrapper mirroring the Engine op API on a plain state, used by the
// differential test. Every query re-evaluates the whole world from scratch.
export class RefWorld {
  constructor({ now = 0 } = {}) {
    this.now = now;
    this.state = refCreateState();
    this.undoStack = [];
    this.redoStack = [];
  }

  _err(code, message) {
    return { ok: false, error: { code, message } };
  }

  _checkpoint() {
    this.undoStack.push(JSON.stringify({
      batches: [...this.state.batches.values()],
      nodes: [...this.state.nodes.values()].map((n) => ({ ...n, deps: [...n.deps] })),
      subs: [...this.state.subs.entries()].map(([k, v]) => [k, [...v]]),
    }));
    this.redoStack = [];
  }

  _restore(payload) {
    const data = JSON.parse(payload);
    this.state = {
      batches: new Map(data.batches.map((b) => [b.id, { ...b }])),
      nodes: new Map(data.nodes.map((n) => [n.id, { ...n, deps: [...n.deps] }])),
      subs: new Map(data.subs.map(([k, v]) => [k, new Set(v)])),
    };
  }

  addBatch({ id, concentration = null, expiry = null }) {
    if (this.state.batches.has(id) || this.state.nodes.has(id)) return this._err('E_DUP', `duplicate id: ${id}`);
    this._checkpoint();
    this.state.batches.set(id, { id, concentration, expiry, withdrawn: false, corrected: false });
    return { ok: true, value: { id } };
  }

  withdrawBatch(id) {
    const b = this.state.batches.get(id);
    if (!b) return this._err('E_REF', `unknown batch: ${id}`);
    this._checkpoint();
    b.withdrawn = true;
    return { ok: true, value: { id } };
  }

  correctConcentration(id, concentration) {
    const b = this.state.batches.get(id);
    if (!b) return this._err('E_REF', `unknown batch: ${id}`);
    this._checkpoint();
    b.corrected = true;
    b.concentration = concentration;
    return { ok: true, value: { id } };
  }

  setExpiry(id, expiry) {
    const b = this.state.batches.get(id);
    if (!b) return this._err('E_REF', `unknown batch: ${id}`);
    this._checkpoint();
    b.expiry = expiry;
    return { ok: true, value: { id } };
  }

  addResult({ id, batch, protocol, deps = [] }) {
    if (this.state.batches.has(id) || this.state.nodes.has(id)) return this._err('E_DUP', `duplicate id: ${id}`);
    if (!this.state.batches.has(batch)) return this._err('E_REF', `unknown batch: ${batch}`);
    for (const d of deps) if (!this.state.nodes.has(d)) return this._err('E_REF', `unknown node: ${d}`);
    this._checkpoint();
    this.state.nodes.set(id, { id, kind: 'result', batchId: batch, protocol, deps: [...new Set(deps)] });
    this.state.subs.set(id, new Set());
    return { ok: true, value: { id } };
  }

  addNode({ id, kind, deps = [] }) {
    if (kind !== 'chart' && kind !== 'conclusion') return this._err('E_REF', `unknown node kind: ${kind}`);
    if (this.state.batches.has(id) || this.state.nodes.has(id)) return this._err('E_DUP', `duplicate id: ${id}`);
    for (const d of deps) if (!this.state.nodes.has(d)) return this._err('E_REF', `unknown node: ${d}`);
    this._checkpoint();
    this.state.nodes.set(id, { id, kind, batchId: null, protocol: null, deps: [...new Set(deps)] });
    return { ok: true, value: { id } };
  }

  addEdge(node, dependsOn) {
    const n = this.state.nodes.get(node);
    if (!n) return this._err('E_REF', `unknown node: ${node}`);
    if (!this.state.nodes.has(dependsOn)) return this._err('E_REF', `unknown node: ${dependsOn}`);
    if (node === dependsOn || refWouldCycle(this.state, node, dependsOn)) {
      return this._err('E_CYCLE', `edge ${node} -> ${dependsOn} closes a cycle`);
    }
    if (n.deps.includes(dependsOn)) return { ok: true, value: { node, dependsOn, added: false } };
    this._checkpoint();
    n.deps.push(dependsOn);
    return { ok: true, value: { node, dependsOn, added: true } };
  }

  addSubstitute(result, batch) {
    const n = this.state.nodes.get(result);
    if (!n || n.kind !== 'result') return this._err('E_REF', `not a result node: ${result}`);
    if (!this.state.batches.has(batch)) return this._err('E_REF', `unknown batch: ${batch}`);
    this._checkpoint();
    this.state.subs.get(result).add(batch);
    return { ok: true, value: { result, batch } };
  }

  removeSubstitute(result, batch) {
    const n = this.state.nodes.get(result);
    if (!n || n.kind !== 'result') return this._err('E_REF', `not a result node: ${result}`);
    if (!this.state.batches.has(batch)) return this._err('E_REF', `unknown batch: ${batch}`);
    this._checkpoint();
    this.state.subs.get(result).delete(batch);
    return { ok: true, value: { result, batch } };
  }

  undo() {
    if (this.undoStack.length === 0) return this._err('E_UNDO', 'nothing to undo');
    this.redoStack.push(JSON.stringify({
      batches: [...this.state.batches.values()],
      nodes: [...this.state.nodes.values()].map((n) => ({ ...n, deps: [...n.deps] })),
      subs: [...this.state.subs.entries()].map(([k, v]) => [k, [...v]]),
    }));
    this._restore(this.undoStack.pop());
    return { ok: true, value: { undone: true } };
  }

  redo() {
    if (this.redoStack.length === 0) return this._err('E_UNDO', 'nothing to redo');
    this.undoStack.push(JSON.stringify({
      batches: [...this.state.batches.values()],
      nodes: [...this.state.nodes.values()].map((n) => ({ ...n, deps: [...n.deps] })),
      subs: [...this.state.subs.entries()].map(([k, v]) => [k, [...v]]),
    }));
    this._restore(this.redoStack.pop());
    return { ok: true, value: { redone: true } };
  }

  computed() {
    return refEvaluate(this.state, this.now);
  }
}
