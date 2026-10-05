'use strict';

/**
 * Dynamic shortest-path engine for AGV dispatch.
 *
 * The map is an undirected weighted graph. Edges can be added, temporarily
 * closed, reopened and reweighted at any time. Every successful mutation
 * (and every undo) bumps a monotonically increasing graph version; query
 * certificates are bound to the version they were issued at, so a stale or
 * foreign certificate is rejected by `verify`.
 *
 * Queries are answered by a complete Dijkstra run at the current state, so a
 * reachable target is never reported as NO_PATH and the UNDECIDED code is
 * reserved (never emitted by this synchronous implementation).
 *
 * Tie-breaking: among all minimum-cost paths the lexicographically smallest
 * node-id sequence (UTF-16 code-unit order on the string form of ids) is
 * returned deterministically.
 */

export const ERR = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  NO_PATH: 'NO_PATH',
  CONFLICT: 'CONFLICT',
  UNDECIDED: 'UNDECIDED',
  CERT_INVALID: 'CERT_INVALID',
});

const MAX_COST = 1e9;

function ok(extra) {
  return Object.assign({ ok: true }, extra);
}

function fail(error, extra) {
  return Object.assign({ ok: false, error }, extra);
}

/** Normalize a node id to its canonical string form, or null if invalid. */
function normNode(x) {
  if (typeof x === 'string' && x.length > 0) return x;
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  return null;
}

function isValidCost(c) {
  return Number.isInteger(c) && c > 0 && c <= MAX_COST;
}

class MinHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }
  get size() {
    return this.keys.length;
  }
  push(key, val) {
    const keys = this.keys;
    const vals = this.vals;
    keys.push(key);
    vals.push(val);
    let i = keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (vals[p] <= vals[i]) break;
      [keys[p], keys[i]] = [keys[i], keys[p]];
      [vals[p], vals[i]] = [vals[i], vals[p]];
      i = p;
    }
  }
  pop() {
    const keys = this.keys;
    const vals = this.vals;
    const topKey = keys[0];
    const topVal = vals[0];
    const lastKey = keys.pop();
    const lastVal = vals.pop();
    if (keys.length > 0) {
      keys[0] = lastKey;
      vals[0] = lastVal;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < keys.length && vals[l] < vals[m]) m = l;
        if (r < keys.length && vals[r] < vals[m]) m = r;
        if (m === i) break;
        [keys[m], keys[i]] = [keys[i], keys[m]];
        [vals[m], vals[i]] = [vals[i], vals[m]];
        i = m;
      }
    }
    return [topKey, topVal];
  }
}

export class AgvGraph {
  constructor() {
    // node -> Map(neighbor -> edgeKey)
    this.adj = new Map();
    // edgeKey -> { a, b, cost, closed }
    this.edges = new Map();
    this.version = 0;
    // Stack of inverse operations for undo (only mutations, never queries).
    this.undoStack = [];
  }

  static edgeKey(a, b) {
    return a < b ? `${a}\n${b}` : `${b}\n${a}`;
  }

  _ensureNode(n) {
    if (!this.adj.has(n)) this.adj.set(n, new Map());
  }

  _bump() {
    this.version += 1;
  }

  // ---- mutations -------------------------------------------------------

  addEdge(u0, v0, cost) {
    const u = normNode(u0);
    const v = normNode(v0);
    if (u === null || v === null || !isValidCost(cost)) return fail(ERR.INVALID_INPUT);
    if (u === v) return fail(ERR.INVALID_INPUT, { reason: 'self-loop' });
    const key = AgvGraph.edgeKey(u, v);
    if (this.edges.has(key)) return fail(ERR.CONFLICT, { reason: 'edge exists' });
    this._ensureNode(u);
    this._ensureNode(v);
    this.edges.set(key, { a: u, b: v, cost, closed: false });
    this.adj.get(u).set(v, key);
    this.adj.get(v).set(u, key);
    this.undoStack.push({ op: 'remove_edge', key });
    this._bump();
    return ok({ version: this.version });
  }

  _removeEdge(key) {
    const e = this.edges.get(key);
    this.edges.delete(key);
    this.adj.get(e.a).delete(e.b);
    this.adj.get(e.b).delete(e.a);
  }

  closeEdge(u0, v0) {
    const u = normNode(u0);
    const v = normNode(v0);
    if (u === null || v === null) return fail(ERR.INVALID_INPUT);
    const key = AgvGraph.edgeKey(u, v);
    const e = this.edges.get(key);
    if (!e) return fail(ERR.CONFLICT, { reason: 'no such edge' });
    if (e.closed) return fail(ERR.CONFLICT, { reason: 'already closed' });
    e.closed = true;
    this.undoStack.push({ op: 'set_closed', key, closed: false });
    this._bump();
    return ok({ version: this.version });
  }

  openEdge(u0, v0) {
    const u = normNode(u0);
    const v = normNode(v0);
    if (u === null || v === null) return fail(ERR.INVALID_INPUT);
    const key = AgvGraph.edgeKey(u, v);
    const e = this.edges.get(key);
    if (!e) return fail(ERR.CONFLICT, { reason: 'no such edge' });
    if (!e.closed) return fail(ERR.CONFLICT, { reason: 'not closed' });
    e.closed = false;
    this.undoStack.push({ op: 'set_closed', key, closed: true });
    this._bump();
    return ok({ version: this.version });
  }

  setCost(u0, v0, cost) {
    const u = normNode(u0);
    const v = normNode(v0);
    if (u === null || v === null || !isValidCost(cost)) return fail(ERR.INVALID_INPUT);
    const key = AgvGraph.edgeKey(u, v);
    const e = this.edges.get(key);
    if (!e) return fail(ERR.CONFLICT, { reason: 'no such edge' });
    const old = e.cost;
    e.cost = cost;
    this.undoStack.push({ op: 'set_cost', key, cost: old });
    this._bump();
    return ok({ version: this.version });
  }

  /**
   * Revert the most recent uncommitted mutation. Queries are committed the
   * moment they are answered and are never on the undo stack, so undo can
   * never retroactively change an issued query result.
   */
  undo() {
    const inv = this.undoStack.pop();
    if (!inv) return fail(ERR.CONFLICT, { reason: 'nothing to undo' });
    if (inv.op === 'remove_edge') {
      this._removeEdge(inv.key);
    } else if (inv.op === 'set_closed') {
      this.edges.get(inv.key).closed = inv.closed;
    } else if (inv.op === 'set_cost') {
      this.edges.get(inv.key).cost = inv.cost;
    } else {
      throw new Error(`unknown inverse op ${inv.op}`);
    }
    // Undo itself is a state transition: certs issued before it must not
    // silently become valid again, so the version still advances.
    this._bump();
    return ok({ version: this.version });
  }

  // ---- shortest path ---------------------------------------------------

  /** Dijkstra over open edges from `src`. Returns Map(node -> dist). */
  _dijkstra(src) {
    const dist = new Map([[src, 0]]);
    const heap = new MinHeap();
    heap.push(src, 0);
    while (heap.size > 0) {
      const [u, d] = heap.pop();
      if (d !== dist.get(u)) continue;
      const nbrs = this.adj.get(u);
      if (!nbrs) continue;
      for (const [v, key] of nbrs) {
        const e = this.edges.get(key);
        if (e.closed) continue;
        const nd = d + e.cost;
        if (!dist.has(v) || nd < dist.get(v)) {
          dist.set(v, nd);
          heap.push(v, nd);
        }
      }
    }
    return dist;
  }

  /**
   * Lexicographically smallest minimum-cost path, built greedily on top of
   * exact integer distance labels from both endpoints: at each step take the
   * smallest neighbour v that lies on some shortest source-target path, i.e.
   * distS[u] + w(u,v) + distT[v] === distS[target].
   */
  _lexPath(src, dst, distS, distT) {
    const total = distS.get(dst);
    const path = [src];
    let u = src;
    while (u !== dst) {
      const du = distS.get(u);
      let best = null;
      for (const [v, key] of this.adj.get(u)) {
        const e = this.edges.get(key);
        if (e.closed) continue;
        if (du + e.cost + distT.get(v) === total) {
          if (best === null || v < best) best = v;
        }
      }
      if (best === null) throw new Error('tight edge invariant violated');
      path.push(best);
      u = best;
    }
    return path;
  }

  _pathCert(src, dst, cost, path, dist) {
    const potentials = {};
    const cutNodes = [];
    for (const [n, d] of [...dist.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      potentials[n] = d;
      if (d < cost) cutNodes.push(n);
    }
    return {
      type: 'path-cert',
      version: this.version,
      source: src,
      target: dst,
      cost,
      path,
      potentials,
      cut: { bound: cost, nodes: cutNodes },
    };
  }

  _noPathCert(src, dst, dist) {
    return {
      type: 'nopath-cert',
      version: this.version,
      source: src,
      target: dst,
      reachable: [...dist.keys()].sort(),
    };
  }

  query(from0, to0) {
    const from = normNode(from0);
    const to = normNode(to0);
    if (from === null || to === null) return fail(ERR.INVALID_INPUT);
    const dist = this._dijkstra(from);
    if (!dist.has(to)) {
      return fail(ERR.NO_PATH, { cert: this._noPathCert(from, to, dist) });
    }
    const cost = dist.get(to);
    const path = from === to ? [from] : this._lexPath(from, to, dist, this._dijkstra(to));
    return ok({ path, cost, cert: this._pathCert(from, to, cost, path, dist) });
  }

  // ---- certificate verification ----------------------------------------

  /**
   * Independently verify an optimality (or unreachability) certificate
   * against the CURRENT graph. Any forgery, staleness or version mismatch
   * yields CERT_INVALID.
   */
  verify(cert) {
    try {
      if (this._verify(cert)) return ok({ version: this.version });
      return fail(ERR.CERT_INVALID);
    } catch {
      return fail(ERR.CERT_INVALID);
    }
  }

  _verify(cert) {
    if (cert === null || typeof cert !== 'object' || Array.isArray(cert)) return false;
    if (!Number.isInteger(cert.version) || cert.version !== this.version) return false;
    if (cert.type === 'path-cert') return this._verifyPathCert(cert);
    if (cert.type === 'nopath-cert') return this._verifyNoPathCert(cert);
    return false;
  }

  _verifyPathCert(cert) {
    const src = normNode(cert.source);
    const dst = normNode(cert.target);
    if (src === null || dst === null) return false;
    if (!Number.isInteger(cert.cost) || cert.cost < 0 || cert.cost > MAX_COST * 200) return false;
    const cost = cert.cost;

    // Path: well-formed, runs source -> target over open edges, sums to cost.
    if (!Array.isArray(cert.path) || cert.path.length < 1) return false;
    const path = cert.path.map(normNode);
    if (path.some((p) => p === null)) return false;
    if (path[0] !== src || path[path.length - 1] !== dst) return false;
    if (new Set(path).size !== path.length) return false; // simple path
    let sum = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const e = this.edges.get(AgvGraph.edgeKey(path[i], path[i + 1]));
      if (!e || e.closed) return false;
      sum += e.cost;
    }
    if (sum !== cost) return false;

    // Potentials: dual-feasible arrival labels anchored at the source.
    const pot = cert.potentials;
    if (pot === null || typeof pot !== 'object' || Array.isArray(pot)) return false;
    const potMap = new Map();
    for (const [n, d] of Object.entries(pot)) {
      if (n.length === 0 || !Number.isInteger(d) || d < 0 || d > MAX_COST * 200) return false;
      if (!this.adj.has(n) && n !== src) return false; // unknown node
      potMap.set(n, d);
    }
    if (potMap.get(src) !== 0) return false;
    if (potMap.get(dst) !== cost) return false;

    // Path nodes must carry potentials equal to their prefix sums.
    let prefix = 0;
    for (let i = 0; i < path.length; i++) {
      if (potMap.get(path[i]) !== prefix) return false;
      if (i + 1 < path.length) {
        prefix += this.edges.get(AgvGraph.edgeKey(path[i], path[i + 1])).cost;
      }
    }

    // Dual feasibility on every open edge: pot[v] <= pot[u] + w both ways.
    // Together with pot[source] = 0 this proves pot[target] is a lower bound
    // on dist(source, target); the exhibited path attains it, hence optimal.
    for (const e of this.edges.values()) {
      if (e.closed) continue;
      const pu = potMap.get(e.a);
      const pv = potMap.get(e.b);
      if (pu === undefined && pv === undefined) continue;
      if (pu === undefined || pv === undefined) return false;
      if (pv > pu + e.cost || pu > pv + e.cost) return false;
    }

    // Cut bound: nodes listed must be exactly those with potential < bound.
    const cut = cert.cut;
    if (cut === null || typeof cut !== 'object') return false;
    if (cut.bound !== cost || !Array.isArray(cut.nodes)) return false;
    const expected = [...potMap.entries()].filter(([, d]) => d < cost).map(([n]) => n).sort();
    const got = [...cut.nodes];
    if (got.some((n) => typeof n !== 'string')) return false;
    got.sort();
    if (expected.length !== got.length) return false;
    for (let i = 0; i < expected.length; i++) if (expected[i] !== got[i]) return false;

    return true;
  }

  _verifyNoPathCert(cert) {
    const src = normNode(cert.source);
    const dst = normNode(cert.target);
    if (src === null || dst === null || src === dst) return false;
    if (!Array.isArray(cert.reachable)) return false;
    const reach = new Set();
    for (const n of cert.reachable) {
      if (typeof n !== 'string' || n.length === 0 || reach.has(n)) return false;
      reach.add(n);
    }
    if (!reach.has(src) || reach.has(dst)) return false;
    // Cut property: no open edge crosses the reachable set boundary, so
    // nothing inside the cut can reach anything outside it (target included).
    for (const e of this.edges.values()) {
      if (e.closed) continue;
      if (reach.has(e.a) !== reach.has(e.b)) return false;
    }
    return true;
  }
}
