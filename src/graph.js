/**
 * Directed dependency graph for payment settlement.
 * An edge u -> v means: settlement of u depends on settlement of v.
 */

export class DependencyGraph {
  #adj = new Map(); // node -> Set of successor nodes

  addNode(u) {
    if (!this.#adj.has(u)) this.#adj.set(u, new Set());
  }

  hasNode(u) {
    return this.#adj.has(u);
  }

  addEdge(u, v) {
    this.addNode(u);
    this.addNode(v);
    this.#adj.get(u).add(v);
  }

  hasEdge(u, v) {
    return this.#adj.has(u) && this.#adj.get(u).has(v);
  }

  removeEdge(u, v) {
    if (!this.hasEdge(u, v)) return false;
    this.#adj.get(u).delete(v);
    return true;
  }

  nodeCount() {
    return this.#adj.size;
  }

  nodes() {
    return [...this.#adj.keys()].sort();
  }

  edges() {
    const out = [];
    for (const u of this.nodes()) {
      for (const v of [...this.#adj.get(u)].sort()) out.push([u, v]);
    }
    return out;
  }

  successors(u) {
    if (!this.#adj.has(u)) return [];
    return [...this.#adj.get(u)].sort();
  }

  /**
   * All nodes reachable from `start` (inclusive), following edge direction,
   * returned as a sorted array.
   */
  reachableFrom(start) {
    if (!this.#adj.has(start)) return [];
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length > 0) {
      const u = stack.pop();
      for (const v of this.#adj.get(u)) {
        if (!seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
      }
    }
    return [...seen].sort();
  }

  /**
   * DFS from `root` following edge direction with sorted neighbor order.
   * Returns a propagation certificate:
   *   { root, dfsEdges, crossComponentEdges }
   * dfsEdges are the tree edges of the DFS; crossComponentEdges are all
   * explored edges whose endpoints lie in different SCCs (per compOf).
   */
  propagationCertificate(root, compOf) {
    const dfsEdges = [];
    const crossComponentEdges = [];
    const visited = new Set([root]);
    const self = this;
    function visit(u) {
      for (const v of self.successors(u)) {
        if (compOf.get(u) !== compOf.get(v)) {
          crossComponentEdges.push([u, v]);
        }
        if (!visited.has(v)) {
          visited.add(v);
          dfsEdges.push([u, v]);
          visit(v);
        }
      }
    }
    visit(root);
    return { root, dfsEdges, crossComponentEdges };
  }

  /**
   * Tarjan's strongly connected components.
   * Returns { components, compOf } where components is a list of sorted
   * member arrays and compOf maps node -> index into components.
   */
  tarjanSCC() {
    const indexOf = new Map();
    const lowlink = new Map();
    const onStack = new Set();
    const stack = [];
    const components = [];
    let nextIndex = 0;
    const self = this;

    function strongConnect(u) {
      indexOf.set(u, nextIndex);
      lowlink.set(u, nextIndex);
      nextIndex += 1;
      stack.push(u);
      onStack.add(u);
      for (const v of self.successors(u)) {
        if (!indexOf.has(v)) {
          strongConnect(v);
          lowlink.set(u, Math.min(lowlink.get(u), lowlink.get(v)));
        } else if (onStack.has(v)) {
          lowlink.set(u, Math.min(lowlink.get(u), indexOf.get(v)));
        }
      }
      if (lowlink.get(u) === indexOf.get(u)) {
        const comp = [];
        for (;;) {
          const w = stack.pop();
          onStack.delete(w);
          comp.push(w);
          if (w === u) break;
        }
        components.push(comp.sort());
      }
    }

    for (const u of this.nodes()) {
      if (!indexOf.has(u)) strongConnect(u);
    }

    const compOf = new Map();
    components.forEach((comp, i) => {
      for (const u of comp) compOf.set(u, i);
    });
    return { components, compOf };
  }

  /**
   * Condensation of the graph: SCCs labelled C0, C1, ... in deterministic
   * topological order (for every condensation edge Ci -> Cj, i < j).
   * Returns { components: [{id, members}], compOf: Map(node -> id),
   *           topoOrder: [ids], condensationEdges: [[id, id]] }.
   */
  condensation() {
    const { components, compOf } = this.tarjanSCC();
    const k = components.length;

    const condAdj = new Map(); // comp index -> Set of comp indices
    const indegree = new Array(k).fill(0);
    for (let i = 0; i < k; i++) condAdj.set(i, new Set());
    for (const [u, v] of this.edges()) {
      const cu = compOf.get(u);
      const cv = compOf.get(v);
      if (cu !== cv && !condAdj.get(cu).has(cv)) {
        condAdj.get(cu).add(cv);
        indegree[cv] += 1;
      }
    }

    // Kahn's algorithm; deterministic tie-break by smallest member.
    const ready = [];
    for (let i = 0; i < k; i++) if (indegree[i] === 0) ready.push(i);
    const order = [];
    while (ready.length > 0) {
      ready.sort((a, b) => (components[a][0] < components[b][0] ? -1 : 1));
      const c = ready.shift();
      order.push(c);
      for (const d of [...condAdj.get(c)].sort()) {
        indegree[d] -= 1;
        if (indegree[d] === 0) ready.push(d);
      }
    }

    const idOf = new Map(); // comp index -> "C<rank>"
    order.forEach((c, rank) => idOf.set(c, `C${rank}`));

    const namedComponents = order.map((c, rank) => ({
      id: `C${rank}`,
      members: components[c],
    }));
    const namedCompOf = new Map();
    for (const [node, idx] of compOf) namedCompOf.set(node, idOf.get(idx));
    const condensationEdges = [];
    for (const c of order) {
      for (const d of [...condAdj.get(c)].sort()) {
        condensationEdges.push([idOf.get(c), idOf.get(d)]);
      }
    }
    condensationEdges.sort();

    return {
      components: namedComponents,
      compOf: namedCompOf,
      topoOrder: namedComponents.map((c) => c.id),
      condensationEdges,
    };
  }
}
