// Dynamic undirected graph. Bridges / articulation points are recomputed
// from the current edge set on every query (iterative Tarjan), so results
// are always identical to a from-scratch replay of the same operations.
export class DynamicGraph {
  #adj = new Map(); // vertex -> Set of neighbours
  #edges = new Set(); // canonical "u,v" keys with u < v

  static key(u, v) {
    return u < v ? `${u},${v}` : `${v},${u}`;
  }

  // Returns true when the edge was actually inserted (idempotent on duplicates).
  addEdge(u, v) {
    const k = DynamicGraph.key(u, v);
    if (this.#edges.has(k)) return false;
    this.#edges.add(k);
    if (!this.#adj.has(u)) this.#adj.set(u, new Set());
    if (!this.#adj.has(v)) this.#adj.set(v, new Set());
    this.#adj.get(u).add(v);
    this.#adj.get(v).add(u);
    return true;
  }

  // Returns true when the edge existed and was removed.
  delEdge(u, v) {
    const k = DynamicGraph.key(u, v);
    if (!this.#edges.has(k)) return false;
    this.#edges.delete(k);
    this.#adj.get(u).delete(v);
    this.#adj.get(v).delete(u);
    return true;
  }

  hasEdge(u, v) {
    return this.#edges.has(DynamicGraph.key(u, v));
  }

  edgeCount() {
    return this.#edges.size;
  }

  // Sorted list of [u, v] with u < v.
  edges() {
    return [...this.#edges]
      .map((k) => k.split(',').map(Number))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  // Single iterative DFS pass computing both bridges and articulation points.
  analyze() {
    const disc = new Map();
    const low = new Map();
    const bridges = [];
    const articulation = new Set();
    let time = 0;

    for (const start of this.#adj.keys()) {
      if (disc.has(start)) continue;
      let rootChildren = 0;
      disc.set(start, time);
      low.set(start, time);
      time += 1;
      const stack = [{ v: start, parent: -1, it: this.#adj.get(start)[Symbol.iterator]() }];
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const next = frame.it.next();
        if (next.done) {
          stack.pop();
          if (stack.length > 0) {
            const p = stack[stack.length - 1];
            if (low.get(frame.v) < low.get(p.v)) low.set(p.v, low.get(frame.v));
            if (low.get(frame.v) > disc.get(p.v)) {
              bridges.push(p.v < frame.v ? [p.v, frame.v] : [frame.v, p.v]);
            }
            if (p.parent !== -1 && low.get(frame.v) >= disc.get(p.v)) {
              articulation.add(p.v);
            }
          }
          continue;
        }
        const w = next.value;
        if (w === frame.parent) continue; // simple graph: no parallel edges
        if (disc.has(w)) {
          if (disc.get(w) < low.get(frame.v)) low.set(frame.v, disc.get(w));
        } else {
          if (frame.parent === -1) rootChildren += 1;
          disc.set(w, time);
          low.set(w, time);
          time += 1;
          stack.push({ v: w, parent: frame.v, it: this.#adj.get(w)[Symbol.iterator]() });
        }
      }
      if (rootChildren >= 2) articulation.add(start);
    }

    bridges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return { bridges, articulation: [...articulation].sort((a, b) => a - b) };
  }

  bridges() {
    return this.analyze().bridges;
  }

  articulationPoints() {
    return this.analyze().articulation;
  }
}
