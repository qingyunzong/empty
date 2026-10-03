'use strict';

const { buildAdjacency, reverseAdjacency, reachable, findCycle } = require('./graph');

class FreezeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FreezeError';
  }
}

const HOLD_TYPES = new Set(['supplier', 'customer']);

class FreezeEngine {
  constructor() {
    this.edges = [];
    this.holds = new Map();
    this.history = [];
  }

  // Loads the batch graph atomically: the graph is validated (must be a DAG)
  // before any state is mutated, so a cyclic input leaves no partial results.
  loadGraph({ edges }) {
    if (!Array.isArray(edges)) {
      throw new FreezeError('graph load requires an "edges" array');
    }
    for (const edge of edges) {
      if (!Array.isArray(edge) || edge.length !== 2 || edge.some((n) => typeof n !== 'string' || n === '')) {
        throw new FreezeError('each edge must be a [child, parent] pair of non-empty strings');
      }
    }
    const adj = buildAdjacency(edges);
    const cycle = findCycle(adj);
    if (cycle) {
      throw new FreezeError(`invalid graph: cycle detected (${cycle.join(' -> ')})`);
    }
    this.edges = edges.map(([child, parent]) => [child, parent]);
    return { lots: adj.size, edges: this.edges.length };
  }

  // Incremental transaction: a split/merge adds child -> parent edges.
  // Validated for cycles before commit; invalid input leaves state untouched.
  addEdges(edges) {
    const next = this.edges.concat(edges);
    const adj = buildAdjacency(next);
    const cycle = findCycle(adj);
    if (cycle) {
      throw new FreezeError(`invalid transaction: cycle detected (${cycle.join(' -> ')})`);
    }
    this.edges = next;
    this.history.push({ op: 'edges', count: edges.length });
    return { edges: this.edges.length };
  }

  addHold({ id, lot, type, severity = null }) {
    if (typeof id !== 'string' || id === '') throw new FreezeError('hold id must be a non-empty string');
    if (typeof lot !== 'string' || lot === '') throw new FreezeError('hold lot must be a non-empty string');
    if (!HOLD_TYPES.has(type)) throw new FreezeError(`hold type must be one of: ${[...HOLD_TYPES].join(', ')}`);
    if (severity !== null && (typeof severity !== 'number' || Number.isNaN(severity))) {
      throw new FreezeError('hold severity must be a number or null');
    }
    if (this.holds.has(id)) throw new FreezeError(`hold already exists: ${id}`);
    const hold = { id, lot, type, severity };
    this.holds.set(id, hold);
    this.history.push({ op: 'hold', hold });
    return hold;
  }

  // Incremental transaction: release a hold. The closure is recomputed from
  // the remaining holds on the next query, so no stale reasons can linger.
  releaseHold(id) {
    const hold = this.holds.get(id);
    if (!hold) throw new FreezeError(`unknown hold: ${id}`);
    this.holds.delete(id);
    this.history.push({ op: 'release', hold });
    return hold;
  }

  undo() {
    const entry = this.history.pop();
    if (!entry) throw new FreezeError('nothing to undo');
    if (entry.op === 'release') {
      this.holds.set(entry.hold.id, entry.hold);
      return { undone: 'release', hold: entry.hold };
    }
    if (entry.op === 'hold') {
      this.holds.delete(entry.hold.id);
      return { undone: 'hold', hold: entry.hold };
    }
    if (entry.op === 'edges') {
      this.edges = this.edges.slice(0, this.edges.length - entry.count);
      return { undone: 'edges', count: entry.count };
    }
    throw new FreezeError(`unknown history entry: ${entry.op}`);
  }

  // Set of lots affected by a single hold. supplier freezes travel downstream
  // (toward derived batches, i.e. reverse of child -> parent); customer
  // freezes travel upstream (toward source batches, along child -> parent).
  affectedLots(hold) {
    const adj = buildAdjacency(this.edges);
    if (hold.type === 'customer') return reachable(adj, hold.lot);
    return reachable(reverseAdjacency(adj), hold.lot);
  }

  allLots() {
    const lots = new Set();
    for (const [child, parent] of this.edges) {
      lots.add(child);
      lots.add(parent);
    }
    for (const hold of this.holds.values()) lots.add(hold.lot);
    return lots;
  }

  // Recomputes the full freeze closure from current holds. For each lot the
  // reason set keeps every triggering hold; effective severity is the numeric
  // maximum, or null when any contributing hold has unknown (null) severity.
  query(lot = null) {
    const reasons = new Map();
    for (const hold of this.holds.values()) {
      for (const affected of this.affectedLots(hold)) {
        if (!reasons.has(affected)) reasons.set(affected, []);
        reasons.get(affected).push(hold);
      }
    }
    const build = (name) => {
      const holds = reasons.get(name) || [];
      let severity = null;
      if (holds.length > 0) {
        severity = holds.some((h) => h.severity === null)
          ? null
          : Math.max(...holds.map((h) => h.severity));
      }
      return {
        lot: name,
        frozen: holds.length > 0,
        severity,
        reasons: holds.map((h) => h.id).sort(),
      };
    };
    if (lot !== null) return build(lot);
    return [...this.allLots()].sort().map(build);
  }

  toJSON() {
    return {
      edges: this.edges,
      holds: [...this.holds.values()],
      history: this.history,
    };
  }

  static fromJSON(data) {
    const engine = new FreezeEngine();
    engine.edges = (data.edges || []).map(([c, p]) => [c, p]);
    engine.holds = new Map((data.holds || []).map((h) => [h.id, h]));
    engine.history = data.history || [];
    return engine;
  }
}

module.exports = { FreezeEngine, FreezeError };
