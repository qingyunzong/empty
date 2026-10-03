export const MAX_VERTICES = 300;
export const MAX_EDGES = 2000;

export class GraphError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function validateVertex(v) {
  if (!Number.isInteger(v) || v < 0 || v >= MAX_VERTICES) {
    throw new GraphError('INVALID_INPUT', `vertex out of range: ${v}`);
  }
}

export class Graph {
  constructor() {
    this.adj = new Map();
    this.edgeCount = 0;
  }

  hasEdge(u, v) {
    const s = this.adj.get(u);
    return s !== undefined && s.has(v);
  }

  addEdge(u, v) {
    validateVertex(u);
    validateVertex(v);
    if (u === v) throw new GraphError('INVALID_INPUT', 'self loop');
    if (this.hasEdge(u, v)) throw new GraphError('INVALID_INPUT', 'duplicate edge');
    if (this.edgeCount >= MAX_EDGES) throw new GraphError('INVALID_INPUT', 'edge limit exceeded');
    if (!this.adj.has(u)) this.adj.set(u, new Set());
    if (!this.adj.has(v)) this.adj.set(v, new Set());
    this.adj.get(u).add(v);
    this.adj.get(v).add(u);
    this.edgeCount++;
  }

  delEdge(u, v) {
    validateVertex(u);
    validateVertex(v);
    if (!this.hasEdge(u, v)) throw new GraphError('NO_SUCH_EDGE', `no such edge: ${u},${v}`);
    this.adj.get(u).delete(v);
    this.adj.get(v).delete(u);
    if (this.adj.get(u).size === 0) this.adj.delete(u);
    if (this.adj.get(v).size === 0) this.adj.delete(v);
    this.edgeCount--;
  }

  vertices() {
    return [...this.adj.keys()].sort((a, b) => a - b);
  }

  edges() {
    const out = [];
    for (const [u, ns] of this.adj) {
      for (const v of ns) if (u < v) out.push([u, v]);
    }
    out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return out;
  }

  bridges() {
    const disc = new Map();
    const low = new Map();
    const result = [];
    let time = 0;
    for (const start of this.adj.keys()) {
      if (disc.has(start)) continue;
      disc.set(start, time);
      low.set(start, time);
      time++;
      const stack = [{ u: start, parent: -1, iter: this.adj.get(start)[Symbol.iterator]() }];
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        const next = top.iter.next();
        if (next.done) {
          stack.pop();
          if (top.parent !== -1) {
            if (low.get(top.u) > disc.get(top.parent)) {
              result.push([Math.min(top.u, top.parent), Math.max(top.u, top.parent)]);
            }
            low.set(top.parent, Math.min(low.get(top.parent), low.get(top.u)));
          }
          continue;
        }
        const v = next.value;
        if (v === top.parent) continue;
        if (disc.has(v)) {
          low.set(top.u, Math.min(low.get(top.u), disc.get(v)));
        } else {
          disc.set(v, time);
          low.set(v, time);
          time++;
          stack.push({ u: v, parent: top.u, iter: this.adj.get(v)[Symbol.iterator]() });
        }
      }
    }
    result.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return result;
  }

  articulationPoints() {
    const disc = new Map();
    const low = new Map();
    const ap = new Set();
    let time = 0;
    for (const start of this.adj.keys()) {
      if (disc.has(start)) continue;
      const root = start;
      let rootChildren = 0;
      disc.set(root, time);
      low.set(root, time);
      time++;
      const stack = [{ u: root, parent: -1, iter: this.adj.get(root)[Symbol.iterator]() }];
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        const next = top.iter.next();
        if (next.done) {
          stack.pop();
          if (top.parent !== -1) {
            low.set(top.parent, Math.min(low.get(top.parent), low.get(top.u)));
            if (top.parent !== root && low.get(top.u) >= disc.get(top.parent)) {
              ap.add(top.parent);
            }
          }
          continue;
        }
        const v = next.value;
        if (v === top.parent) continue;
        if (disc.has(v)) {
          low.set(top.u, Math.min(low.get(top.u), disc.get(v)));
        } else {
          disc.set(v, time);
          low.set(v, time);
          time++;
          if (top.u === root) rootChildren++;
          stack.push({ u: v, parent: top.u, iter: this.adj.get(v)[Symbol.iterator]() });
        }
      }
      if (rootChildren >= 2) ap.add(root);
    }
    return [...ap].sort((a, b) => a - b);
  }

  canonical() {
    return this.edges().map(([u, v]) => `${u},${v}`).join(';');
  }
}
