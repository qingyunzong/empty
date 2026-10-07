export class TraceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TraceError';
    this.code = code;
  }
}

export const EDGE_KINDS = new Set(['consume', 'split', 'merge', 'rework']);
const EPS = 1e-9;

// Lineage graph: nodes are lots, edges are consume/split/merge/rework with qty+time.
// Propagation semantics: noisy-or over edge ratios.
//   p(source) = 1
//   p(v) = 1 - prod_{u->v}(1 - p(u) * ratio(u,v))
// Frozen lots are contained: they keep their own probability but do not pass it on.
export class LineageGraph {
  constructor() {
    this.lots = new Map();
    this.edges = new Map();
    this._out = new Map();
    this._in = new Map();
  }

  addLot(lot) {
    if (!lot || typeof lot.id !== 'string' || lot.id === '') {
      throw new TraceError('ERR_LOT', 'lot id required');
    }
    if (this.lots.has(lot.id)) throw new TraceError('ERR_DUP_LOT', `lot ${lot.id} already exists`);
    if (!(lot.qty > 0)) throw new TraceError('ERR_LOT', `lot ${lot.id} qty must be > 0`);
    const rec = { kind: 'wip', time: null, frozen: false, failed: false, ...lot };
    this.lots.set(rec.id, rec);
    this._out.set(rec.id, new Set());
    this._in.set(rec.id, new Set());
    return rec;
  }

  removeLot(id) {
    if (!this.lots.has(id)) throw new TraceError('ERR_NO_LOT', `lot ${id} not found`);
    if (this._out.get(id).size || this._in.get(id).size) {
      throw new TraceError('ERR_LOT_IN_USE', `lot ${id} still has edges`);
    }
    this.lots.delete(id);
    this._out.delete(id);
    this._in.delete(id);
  }

  _checkEdgeConservation(candidate, ignoreId = null) {
    if (candidate.ratio > 1 + EPS) {
      throw new TraceError('ERR_CONSERVATION', `edge ${candidate.id} ratio ${candidate.ratio} exceeds 1`);
    }
    if (candidate.kind === 'split') {
      let sum = candidate.ratio;
      for (const eid of this._out.get(candidate.from)) {
        if (eid === ignoreId) continue;
        const e = this.edges.get(eid);
        if (e.kind === 'split') sum += e.ratio;
      }
      if (sum > 1 + EPS) {
        throw new TraceError('ERR_CONSERVATION', `split ratios out of ${candidate.from} would sum to ${sum} > 1`);
      }
    }
    if (candidate.kind === 'merge') {
      const to = this.lots.get(candidate.to);
      let sum = candidate.qty;
      for (const eid of this._in.get(candidate.to)) {
        if (eid === ignoreId) continue;
        const e = this.edges.get(eid);
        if (e.kind === 'merge') sum += e.qty;
      }
      if (sum > to.qty + EPS) {
        throw new TraceError('ERR_CONSERVATION', `merge inputs into ${candidate.to} would exceed lot qty ${to.qty}`);
      }
    }
  }

  addEdge(edge) {
    if (!edge || typeof edge.id !== 'string' || edge.id === '') {
      throw new TraceError('ERR_EDGE', 'edge id required');
    }
    if (this.edges.has(edge.id)) throw new TraceError('ERR_DUP_EDGE', `edge ${edge.id} already exists`);
    const from = this.lots.get(edge.from);
    if (!from) throw new TraceError('ERR_NO_LOT', `lot ${edge.from} not found`);
    if (!this.lots.has(edge.to)) throw new TraceError('ERR_NO_LOT', `lot ${edge.to} not found`);
    if (!EDGE_KINDS.has(edge.kind)) throw new TraceError('ERR_KIND', `unknown edge kind ${edge.kind}`);
    if (!(edge.qty > 0)) throw new TraceError('ERR_EDGE', `edge ${edge.id} qty must be > 0`);
    if (this._reachable(edge.to, edge.from)) {
      throw new TraceError('ERR_CYCLE', `edge ${edge.id} (${edge.from} -> ${edge.to}) would close a cycle`);
    }
    const rec = { time: null, ...edge, ratio: edge.qty / from.qty };
    this._checkEdgeConservation(rec);
    this.edges.set(rec.id, rec);
    this._out.get(rec.from).add(rec.id);
    this._in.get(rec.to).add(rec.id);
    return rec;
  }

  removeEdge(id) {
    const e = this.edges.get(id);
    if (!e) throw new TraceError('ERR_NO_EDGE', `edge ${id} not found`);
    this.edges.delete(id);
    this._out.get(e.from).delete(id);
    this._in.get(e.to).delete(id);
  }

  correctEdge(id, patch) {
    const e = this.edges.get(id);
    if (!e) throw new TraceError('ERR_NO_EDGE', `edge ${id} not found`);
    const from = this.lots.get(e.from);
    const old = { qty: e.qty };
    const next = { ...e };
    if (patch.qty !== undefined) {
      if (!(patch.qty > 0)) throw new TraceError('ERR_EDGE', 'corrected qty must be > 0');
      next.qty = patch.qty;
      next.ratio = patch.qty / from.qty;
    } else if (patch.ratio !== undefined) {
      if (!(patch.ratio > 0)) throw new TraceError('ERR_EDGE', 'corrected ratio must be > 0');
      next.ratio = patch.ratio;
      next.qty = patch.ratio * from.qty;
    } else {
      throw new TraceError('ERR_EDGE', 'correct requires qty or ratio');
    }
    this._checkEdgeConservation(next, id);
    this.edges.set(id, next);
    return old;
  }

  _reachable(start, target) {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const v = stack.pop();
      if (v === target) return true;
      for (const eid of this._out.get(v) ?? []) {
        const w = this.edges.get(eid).to;
        if (!seen.has(w)) {
          seen.add(w);
          stack.push(w);
        }
      }
    }
    return false;
  }

  descendants(id) {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const v = stack.pop();
      for (const eid of this._out.get(v) ?? []) {
        const w = this.edges.get(eid).to;
        if (!seen.has(w)) {
          seen.add(w);
          stack.push(w);
        }
      }
    }
    return seen;
  }

  _topoOrder(nodes) {
    const indeg = new Map();
    for (const v of nodes) indeg.set(v, 0);
    for (const v of nodes) {
      for (const eid of this._out.get(v)) {
        const w = this.edges.get(eid).to;
        if (nodes.has(w)) indeg.set(w, indeg.get(w) + 1);
      }
    }
    const queue = [...nodes].filter((v) => indeg.get(v) === 0).sort();
    const order = [];
    while (queue.length) {
      const v = queue.shift();
      order.push(v);
      for (const eid of this._out.get(v)) {
        const w = this.edges.get(eid).to;
        if (!nodes.has(w)) continue;
        indeg.set(w, indeg.get(w) - 1);
        if (indeg.get(w) === 0) queue.push(w);
      }
    }
    if (order.length !== nodes.size) throw new TraceError('ERR_CYCLE', 'cycle detected in subgraph');
    return order;
  }

  // Fills `probs` (Map) for every node in `scope`, reading parents outside
  // `scope` from the existing entries of `probs`. This single routine serves
  // both full computation (scope = whole descendant cone, empty map) and
  // incremental recomputation (scope = affected subgraph, primed map).
  computeProbs(sourceId, scope, probs) {
    const order = this._topoOrder(scope);
    for (const v of order) {
      if (v === sourceId) {
        probs.set(v, 1);
        continue;
      }
      let prod = 1;
      let any = false;
      for (const eid of this._in.get(v)) {
        const e = this.edges.get(eid);
        const lotU = this.lots.get(e.from);
        if (!lotU) continue;
        if (lotU.frozen && e.from !== sourceId) continue; // freeze containment
        const pu = probs.get(e.from);
        if (pu === undefined) continue;
        any = true;
        prod *= 1 - pu * e.ratio;
      }
      probs.set(v, any ? 1 - prod : 0);
    }
    return probs;
  }

  // Max-product witness path per node, used for the recall certificate.
  witnesses(sourceId, scope) {
    const order = this._topoOrder(scope);
    const best = new Map([[sourceId, { prob: 1, path: [sourceId] }]]);
    for (const v of order) {
      if (v === sourceId) continue;
      let bestProb = 0;
      let bestPath = null;
      for (const eid of this._in.get(v)) {
        const e = this.edges.get(eid);
        const lotU = this.lots.get(e.from);
        if (!lotU) continue;
        if (lotU.frozen && e.from !== sourceId) continue;
        const b = best.get(e.from);
        if (!b) continue;
        const cand = b.prob * e.ratio;
        if (cand > bestProb) {
          bestProb = cand;
          bestPath = [...b.path, v];
        }
      }
      if (bestPath) best.set(v, { prob: bestProb, path: bestPath });
    }
    return best;
  }

  checkConservation() {
    const violations = [];
    for (const [id, lot] of this.lots) {
      let splitSum = 0;
      for (const eid of this._out.get(id)) {
        const e = this.edges.get(eid);
        if (e.kind === 'split') splitSum += e.ratio;
      }
      if (splitSum > 1 + EPS) violations.push({ lot: id, rule: 'split-ratio-sum<=1', actual: splitSum });
      let mergeSum = 0;
      for (const eid of this._in.get(id)) {
        const e = this.edges.get(eid);
        if (e.kind === 'merge') mergeSum += e.qty;
      }
      if (mergeSum > 0 && Math.abs(mergeSum - lot.qty) > EPS) {
        violations.push({ lot: id, rule: 'merge-qty-balance', expected: lot.qty, actual: mergeSum });
      }
    }
    return { ok: violations.length === 0, violations };
  }
}
