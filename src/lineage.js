'use strict';

const EPS = 1e-9;

const EDGE_KINDS = new Set(['consume', 'split', 'merge', 'rework']);
const LOT_STATUSES = new Set(['quarantine', 'in_stock', 'in_transit', 'delivered', 'consumed']);
// Freeze rule: lots in these statuses can still be frozen / recalled.
const FREEZABLE = new Set(['quarantine', 'in_stock', 'in_transit', 'delivered']);

class LineageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LineageError';
    this.code = code;
  }
}

class LineageGraph {
  constructor() {
    this.lots = new Map();
    this.edges = new Map();
    this.outEdges = new Map(); // lotId -> Set(edgeId)
    this.inEdges = new Map();  // lotId -> Set(edgeId)
  }

  hasLot(id) {
    return this.lots.has(id);
  }

  addLot(lot) {
    const { id, kind, qty, status } = lot;
    if (!id || typeof id !== 'string') throw new LineageError('ERR_LOT', 'lot id required');
    if (this.lots.has(id)) throw new LineageError('ERR_LOT', `duplicate lot ${id}`);
    if (!(qty > 0)) throw new LineageError('ERR_LOT', `lot ${id}: qty must be > 0`);
    if (!LOT_STATUSES.has(status)) throw new LineageError('ERR_LOT', `lot ${id}: bad status ${status}`);
    this.lots.set(id, { id, kind: kind || 'wip', qty, status });
    this.outEdges.set(id, new Set());
    this.inEdges.set(id, new Set());
    return this.lots.get(id);
  }

  removeLot(id) {
    const lot = this.lots.get(id);
    if (!lot) throw new LineageError('ERR_LOT', `unknown lot ${id}`);
    if (this.outEdges.get(id).size || this.inEdges.get(id).size) {
      throw new LineageError('ERR_LOT', `lot ${id} still has edges`);
    }
    this.lots.delete(id);
    this.outEdges.delete(id);
    this.inEdges.delete(id);
    return lot;
  }

  outRatioSum(lotId, excludeEdgeId) {
    let sum = 0;
    for (const eid of this.outEdges.get(lotId)) {
      if (eid !== excludeEdgeId) sum += this.edges.get(eid).ratio;
    }
    return sum;
  }

  validateEdgeShape(edge) {
    const { id, from, to, kind, qty, ratio } = edge;
    if (!id || typeof id !== 'string') throw new LineageError('ERR_EDGE', 'edge id required');
    if (!this.lots.has(from)) throw new LineageError('ERR_EDGE', `edge ${id}: unknown source lot ${from}`);
    if (!this.lots.has(to)) throw new LineageError('ERR_EDGE', `edge ${id}: unknown target lot ${to}`);
    if (from === to) throw new LineageError('ERR_CYCLE', `edge ${id}: self loop on ${from}`);
    if (!EDGE_KINDS.has(kind)) throw new LineageError('ERR_EDGE', `edge ${id}: bad kind ${kind}`);
    if (!(qty > 0)) throw new LineageError('ERR_EDGE', `edge ${id}: qty must be > 0`);
    if (!(ratio > 0) || ratio > 1 + EPS) {
      throw new LineageError('ERR_CONSERVATION', `edge ${id}: ratio ${ratio} outside (0,1]`);
    }
    if (!Number.isFinite(edge.time)) throw new LineageError('ERR_EDGE', `edge ${id}: time required`);
  }

  // Ratio conservation: a lot cannot distribute more than 100% of itself
  // across its outgoing consume/split/merge/rework edges.
  checkConservation(lotId, candidateRatio, excludeEdgeId) {
    const total = this.outRatioSum(lotId, excludeEdgeId) + candidateRatio;
    if (total > 1 + EPS) {
      throw new LineageError(
        'ERR_CONSERVATION',
        `lot ${lotId}: outgoing ratio sum ${total.toFixed(6)} exceeds 1`,
      );
    }
  }

  reachable(fromId, toId) {
    if (fromId === toId) return true;
    const seen = new Set([fromId]);
    const stack = [fromId];
    while (stack.length) {
      const cur = stack.pop();
      for (const eid of this.outEdges.get(cur)) {
        const nxt = this.edges.get(eid).to;
        if (nxt === toId) return true;
        if (!seen.has(nxt)) {
          seen.add(nxt);
          stack.push(nxt);
        }
      }
    }
    return false;
  }

  addEdge(edge) {
    if (this.edges.has(edge.id)) throw new LineageError('ERR_EDGE', `duplicate edge ${edge.id}`);
    this.validateEdgeShape(edge);
    // Cycle check: adding from->to must not make `from` reachable from `to`.
    if (this.reachable(edge.to, edge.from)) {
      throw new LineageError('ERR_CYCLE', `edge ${edge.id}: ${edge.from}->${edge.to} closes a cycle`);
    }
    this.checkConservation(edge.from, edge.ratio, null);
    const stored = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      qty: edge.qty,
      ratio: edge.ratio,
      time: edge.time,
      prob: edge.prob != null ? edge.prob : edge.ratio,
    };
    this.edges.set(stored.id, stored);
    this.outEdges.get(stored.from).add(stored.id);
    this.inEdges.get(stored.to).add(stored.id);
    return stored;
  }

  removeEdge(id) {
    const edge = this.edges.get(id);
    if (!edge) throw new LineageError('ERR_EDGE', `unknown edge ${id}`);
    this.edges.delete(id);
    this.outEdges.get(edge.from).delete(id);
    this.inEdges.get(edge.to).delete(id);
    return edge;
  }

  // Correct mutable fields of an edge (ratio/qty/prob/time). Endpoints are
  // identity: changing them is remove+add. Returns the previous edge state.
  correctEdge(id, patch) {
    const prev = { ...this.edges.get(id) };
    if (!this.edges.has(id)) throw new LineageError('ERR_EDGE', `unknown edge ${id}`);
    if (patch.from != null || patch.to != null || patch.kind != null) {
      throw new LineageError('ERR_EDGE', 'correct() only patches ratio/qty/prob/time');
    }
    const next = { ...prev, ...patch, id: prev.id, from: prev.from, to: prev.to, kind: prev.kind };
    // prob defaults to ratio; if it was never explicitly overridden and the
    // correction changes ratio without touching prob, keep it tracking ratio.
    if (patch.ratio != null && patch.prob == null && prev.prob === prev.ratio) {
      next.prob = next.ratio;
    }
    this.validateEdgeShape(next);
    this.checkConservation(next.from, next.ratio, id);
    this.edges.set(id, next);
    return prev;
  }

  restoreEdge(edge) {
    this.edges.set(edge.id, { ...edge });
    this.outEdges.get(edge.from).add(edge.id);
    this.inEdges.get(edge.to).add(edge.id);
  }

  // Ancestors of lotId (including itself): exactly the lots whose impact
  // query results can change when something at/below lotId is mutated.
  ancestorsOf(lotId) {
    const seen = new Set();
    const stack = [lotId];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const eid of this.inEdges.get(cur) || []) {
        stack.push(this.edges.get(eid).from);
      }
    }
    return seen;
  }

  // Cumulative contamination probability downstream of sourceId.
  // Exact noisy-or over the DAG evaluated in topological order.
  downstreamProbs(sourceId) {
    if (!this.lots.has(sourceId)) throw new LineageError('ERR_LOT', `unknown lot ${sourceId}`);
    // Collect reachable subgraph.
    const reachableSet = new Set([sourceId]);
    const stack = [sourceId];
    while (stack.length) {
      const cur = stack.pop();
      for (const eid of this.outEdges.get(cur)) {
        const nxt = this.edges.get(eid).to;
        if (!reachableSet.has(nxt)) {
          reachableSet.add(nxt);
          stack.push(nxt);
        }
      }
    }
    // Kahn topological order over the reachable subgraph (graph is a DAG;
    // cycle creation is rejected at edge-insert time).
    const indeg = new Map();
    for (const id of reachableSet) indeg.set(id, 0);
    for (const id of reachableSet) {
      for (const eid of this.outEdges.get(id)) {
        const e = this.edges.get(eid);
        if (reachableSet.has(e.to)) indeg.set(e.to, indeg.get(e.to) + 1);
      }
    }
    const queue = [];
    for (const [id, d] of indeg) if (d === 0) queue.push(id);
    const fail = new Map(); // fail(n) = probability lot n stays uncontaminated
    for (const id of reachableSet) fail.set(id, 1);
    fail.set(sourceId, 0);
    while (queue.length) {
      const cur = queue.shift();
      const pCur = 1 - fail.get(cur);
      for (const eid of this.outEdges.get(cur)) {
        const e = this.edges.get(eid);
        if (!reachableSet.has(e.to)) continue;
        // noisy-or: target stays clean only if it also escapes via this edge
        fail.set(e.to, fail.get(e.to) * (1 - pCur * e.prob));
        const d = indeg.get(e.to) - 1;
        indeg.set(e.to, d);
        if (d === 0) queue.push(e.to);
      }
    }
    const probs = new Map();
    for (const id of reachableSet) probs.set(id, 1 - fail.get(id));
    return probs;
  }

  // Impact analysis: affected set = downstream lots whose cumulative
  // probability reaches `threshold` and which the freeze rule can still hold
  // (status != consumed). The source lot itself is reported separately.
  impact(sourceId, threshold = 0.5) {
    const probs = this.downstreamProbs(sourceId);
    const affected = [];
    for (const [id, prob] of probs) {
      if (id === sourceId) continue;
      const lot = this.lots.get(id);
      if (prob + EPS >= threshold && FREEZABLE.has(lot.status)) {
        affected.push({
          lot: id,
          kind: lot.kind,
          status: lot.status,
          prob,
          action: lot.status === 'delivered' ? 'customer_notify' : 'freeze',
        });
      }
    }
    affected.sort((a, b) => (a.lot < b.lot ? -1 : 1));
    const certificate = this.buildCertificate(sourceId, threshold, probs, affected);
    return { source: sourceId, threshold, affected, certificate };
  }

  // Minimal recall certificate: the affected set is exactly the predicate
  // closure, so every listed lot is individually required (removing it
  // leaves a rule-satisfying lot unlisted) and no unlisted lot qualifies.
  buildCertificate(sourceId, threshold, probs, affected) {
    const listed = new Set(affected.map((a) => a.lot));
    const predicate = (id) => {
      if (id === sourceId) return false;
      const lot = this.lots.get(id);
      return probs.get(id) + EPS >= threshold && FREEZABLE.has(lot.status);
    };
    const evidence = affected.map((a) => ({
      lot: a.lot,
      prob: a.prob,
      rule: `prob(${a.lot})=${a.prob.toFixed(6)} >= ${threshold} && status=${a.status} freezable`,
      required: predicate(a.lot),
    }));
    const minimal = evidence.every((e) => e.required);
    let complete = true;
    for (const id of probs.keys()) {
      if (!listed.has(id) && predicate(id)) complete = false;
    }
    return {
      rule: 'prob >= threshold AND status in (quarantine,in_stock,in_transit,delivered)',
      minimal,
      complete,
      evidence,
    };
  }
}

module.exports = { LineageGraph, LineageError, EDGE_KINDS, LOT_STATUSES, FREEZABLE, EPS };
