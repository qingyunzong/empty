export const ERRORS = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  NO_PATH: 'NO_PATH',
  CONFLICT: 'CONFLICT',
  UNDECIDED: 'UNDECIDED',
  CERT_INVALID: 'CERT_INVALID',
});

export class GraphError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'GraphError';
    this.code = code;
  }
}

function normNode(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new GraphError(ERRORS.INVALID_INPUT, `invalid node id: ${JSON.stringify(value)}`);
}

function normCost(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new GraphError(ERRORS.INVALID_INPUT, `invalid edge cost: ${JSON.stringify(value)}`);
  }
  return value;
}

function normEdgeId(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new GraphError(ERRORS.INVALID_INPUT, `invalid edge id: ${JSON.stringify(value)}`);
}

// Lexicographic comparison of two node-id arrays (code-unit order on strings).
export function comparePaths(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function pathsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

class MinHeap {
  constructor(cmp) {
    this.items = [];
    this.cmp = cmp;
  }

  get size() {
    return this.items.length;
  }

  push(value) {
    const a = this.items;
    a.push(value);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[i], a[p]) < 0) {
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      } else break;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

export class DynamicGraph {
  constructor() {
    this.edges = new Map(); // id -> { id, from, to, cost, open }
    this.undoStack = []; // stack of inverse thunks, one per mutation
    this.version = 0; // bumped on every mutation and every undo
    this.autoId = 0;
  }

  _bump() {
    this.version += 1;
  }

  addEdge({ id, from, to, cost } = {}) {
    const edgeId = id === undefined || id === null ? `e${this.autoId++}` : normEdgeId(id);
    if (this.edges.has(edgeId)) {
      throw new GraphError(ERRORS.CONFLICT, `edge id already exists: ${edgeId}`);
    }
    const edge = { id: edgeId, from: normNode(from), to: normNode(to), cost: normCost(cost), open: true };
    this.edges.set(edgeId, edge);
    this.undoStack.push(() => {
      this.edges.delete(edgeId);
    });
    this._bump();
    return edgeId;
  }

  _getEdge(id) {
    const edgeId = normEdgeId(id);
    const edge = this.edges.get(edgeId);
    if (!edge) throw new GraphError(ERRORS.INVALID_INPUT, `unknown edge id: ${edgeId}`);
    return edge;
  }

  _mutateEdge(id, apply) {
    const edge = this._getEdge(id);
    const before = { cost: edge.cost, open: edge.open };
    apply(edge);
    this.undoStack.push(() => {
      edge.cost = before.cost;
      edge.open = before.open;
    });
    this._bump();
  }

  close(id) {
    this._mutateEdge(id, (edge) => {
      edge.open = false;
    });
  }

  open(id) {
    this._mutateEdge(id, (edge) => {
      edge.open = true;
    });
  }

  setCost(id, cost) {
    const newCost = normCost(cost);
    this._mutateEdge(id, (edge) => {
      edge.cost = newCost;
    });
  }

  undo() {
    const revert = this.undoStack.pop();
    if (!revert) throw new GraphError(ERRORS.CONFLICT, 'nothing to undo');
    revert();
    this._bump();
  }

  _adjacency() {
    const adj = new Map();
    for (const edge of this.edges.values()) {
      if (!edge.open) continue;
      if (!adj.has(edge.from)) adj.set(edge.from, []);
      adj.get(edge.from).push({ to: edge.to, cost: edge.cost });
    }
    return adj;
  }

  // Label-correcting Dijkstra over the total order (cost, path-lexicographic).
  // Only simple paths are considered; labels improve monotonically so it
  // always terminates and never reports a reachable node as unreachable.
  _computeAll(source) {
    const adj = this._adjacency();
    const dist = new Map([[source, 0]]);
    const best = new Map([[source, [source]]]);
    const heap = new MinHeap((a, b) => {
      if (a.cost !== b.cost) return a.cost - b.cost;
      return comparePaths(a.path, b.path);
    });
    heap.push({ node: source, cost: 0, path: [source] });
    while (heap.size > 0) {
      const cur = heap.pop();
      if (cur.cost !== dist.get(cur.node) || !pathsEqual(cur.path, best.get(cur.node))) continue;
      const out = adj.get(cur.node);
      if (!out) continue;
      for (const { to, cost } of out) {
        if (cur.path.includes(to)) continue; // simple paths only
        const nextCost = cur.cost + cost;
        const nextPath = [...cur.path, to];
        const oldCost = dist.get(to);
        if (
          oldCost === undefined ||
          nextCost < oldCost ||
          (nextCost === oldCost && comparePaths(nextPath, best.get(to)) < 0)
        ) {
          dist.set(to, nextCost);
          best.set(to, nextPath);
          heap.push({ node: to, cost: nextCost, path: nextPath });
        }
      }
    }
    return { dist, best };
  }

  query(from, to) {
    const s = normNode(from);
    const t = normNode(to);
    const { dist, best } = this._computeAll(s);
    if (!dist.has(t)) {
      throw new GraphError(ERRORS.NO_PATH, `no path from ${s} to ${t}`);
    }
    const cost = dist.get(t);
    const path = best.get(t);
    const distObj = {};
    for (const key of [...dist.keys()].sort()) distObj[key] = dist.get(key);
    const cert = { version: this.version, from: s, to: t, cost, path: [...path], dist: distObj };
    return { path: [...path], cost, cert };
  }

  _openEdgesBetween(u, v) {
    const out = [];
    for (const edge of this.edges.values()) {
      if (edge.open && edge.from === u && edge.to === v) out.push(edge.cost);
    }
    return out;
  }

  // Verifies an optimality certificate against the CURRENT graph version.
  // The certificate carries node potentials (shortest-distance labels):
  //   dist[from] = 0 and dist[v] <= dist[u] + w for every open edge (u,v,w)
  // prove dist[t] is a lower bound on any s->t walk; the exhibited tight
  // path attains it, hence optimality. Any forgery, staleness or version
  // mismatch throws CERT_INVALID.
  verify(cert) {
    const fail = () => {
      throw new GraphError(ERRORS.CERT_INVALID, 'certificate validation failed');
    };
    try {
      if (!cert || typeof cert !== 'object' || Array.isArray(cert)) fail();
      const { version, from, to, cost, path, dist } = cert;
      if (!Number.isInteger(version) || version !== this.version) fail();
      const s = normNode(from);
      const t = normNode(to);
      normCost(cost);
      if (!Array.isArray(path) || path.length === 0) fail();
      const nodes = path.map(normNode);
      if (nodes[0] !== s || nodes[nodes.length - 1] !== t) fail();
      if (!dist || typeof dist !== 'object' || Array.isArray(dist)) fail();
      const d = new Map();
      for (const [key, value] of Object.entries(dist)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail();
        d.set(key, value);
      }
      if (d.get(s) !== 0) fail();
      if (d.get(t) !== cost) fail();
      // Potential (cut-bound) constraints over every open edge.
      for (const edge of this.edges.values()) {
        if (!edge.open) continue;
        const du = d.get(edge.from);
        if (du === undefined) continue;
        const dv = d.get(edge.to);
        if (dv === undefined || dv > du + edge.cost) fail();
      }
      // Path must exist, be open, be tight w.r.t. potentials, and sum to cost.
      let sum = 0;
      for (let i = 0; i + 1 < nodes.length; i += 1) {
        const u = nodes[i];
        const v = nodes[i + 1];
        const du = d.get(u);
        const dv = d.get(v);
        if (du === undefined || dv === undefined) fail();
        const slack = dv - du;
        if (slack < 0) fail();
        if (!this._openEdgesBetween(u, v).some((w) => w === slack)) fail();
        sum += slack;
      }
      if (sum !== cost) fail();
      return true;
    } catch (err) {
      if (err instanceof GraphError && err.code === ERRORS.CERT_INVALID) throw err;
      fail();
    }
    return false; // unreachable
  }
}
