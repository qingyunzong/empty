'use strict';

// Dinic max-flow with explicit residual edges (objects, so we can read flows back).
class Dinic {
  constructor(size) {
    this.size = size;
    this.graph = Array.from({ length: size }, () => []);
  }

  addEdge(from, to, capacity) {
    const forward = { to, capacity, flow: 0, reverse: null };
    const backward = { to: from, capacity: 0, flow: 0, reverse: forward };
    forward.reverse = backward;
    this.graph[from].push(forward);
    this.graph[to].push(backward);
    return forward;
  }

  maxFlow(source, sink) {
    let total = 0;
    const level = new Array(this.size);
    const next = new Array(this.size);
    while (this.#bfs(source, sink, level)) {
      next.fill(0);
      let pushed;
      while ((pushed = this.#dfs(source, sink, Infinity, level, next)) > 0) {
        total += pushed;
      }
    }
    return total;
  }

  #bfs(source, sink, level) {
    level.fill(-1);
    const queue = [source];
    level[source] = 0;
    for (let head = 0; head < queue.length; head += 1) {
      const v = queue[head];
      for (const edge of this.graph[v]) {
        if (edge.capacity - edge.flow > 0 && level[edge.to] === -1) {
          level[edge.to] = level[v] + 1;
          queue.push(edge.to);
        }
      }
    }
    return level[sink] !== -1;
  }

  #dfs(v, sink, f, level, next) {
    if (v === sink) return f;
    const edges = this.graph[v];
    for (; next[v] < edges.length; next[v] += 1) {
      const edge = edges[next[v]];
      if (edge.capacity - edge.flow > 0 && level[edge.to] === level[v] + 1) {
        const pushed = this.#dfs(edge.to, sink, Math.min(f, edge.capacity - edge.flow), level, next);
        if (pushed > 0) {
          edge.flow += pushed;
          edge.reverse.flow -= pushed;
          return pushed;
        }
      }
    }
    return 0;
  }

  reachableFrom(source) {
    const seen = new Array(this.size).fill(false);
    const queue = [source];
    seen[source] = true;
    for (let head = 0; head < queue.length; head += 1) {
      const v = queue[head];
      for (const edge of this.graph[v]) {
        if (edge.capacity - edge.flow > 0 && !seen[edge.to]) {
          seen[edge.to] = true;
          queue.push(edge.to);
        }
      }
    }
    return seen;
  }
}

// Solve a circulation problem with lower/upper bounds.
// edges: [{ from, to, lower, upper }] with 0 <= lower <= upper.
// Returns either:
//   { feasible: true, flows: { "from->to": amount, ... } }
// or:
//   { feasible: false, deficits: [{ node, amount }], cut: { nodes, lowerOut, upperIn, violation } }
// The cut is a set Y of nodes with lower(Y -> V\Y) > upper(V\Y -> Y),
// i.e. a concrete Hoffmann-criterion violation certifying infeasibility.
function solveCirculation(edges) {
  const nodes = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort();
  const index = new Map(nodes.map((name, i) => [name, i]));
  const n = nodes.length;
  const source = n;
  const sink = n + 1;
  const dinic = new Dinic(n + 2);

  // demand[v] = (lower leaving v) - (lower entering v); f' must net-export demand[v] from v.
  const demand = new Array(n).fill(0);
  const edgeRefs = [];
  for (const edge of edges) {
    const u = index.get(edge.from);
    const v = index.get(edge.to);
    demand[u] += edge.lower;
    demand[v] -= edge.lower;
    edgeRefs.push({ edge, ref: dinic.addEdge(u, v, edge.upper - edge.lower) });
  }

  const supplyRefs = new Map();
  let totalSupply = 0;
  for (let i = 0; i < n; i += 1) {
    if (demand[i] < 0) {
      supplyRefs.set(i, dinic.addEdge(source, i, -demand[i]));
      totalSupply += -demand[i];
    } else if (demand[i] > 0) {
      dinic.addEdge(i, sink, demand[i]);
    }
  }

  const flow = dinic.maxFlow(source, sink);
  if (flow === totalSupply) {
    const flows = {};
    for (const { edge, ref } of edgeRefs) {
      flows[`${edge.from}->${edge.to}`] = edge.lower + ref.flow;
    }
    return { feasible: true, flows };
  }

  // Infeasible: min-cut certificate from the residual graph.
  const seen = dinic.reachableFrom(source);
  const cutNodes = nodes.filter((_, i) => !seen[i]); // sink side Y
  const inCut = new Set(cutNodes);
  let lowerOut = 0;
  let upperIn = 0;
  for (const edge of edges) {
    const fromIn = inCut.has(edge.from);
    const toIn = inCut.has(edge.to);
    if (fromIn && !toIn) lowerOut += edge.lower;
    if (!fromIn && toIn) upperIn += edge.upper;
  }
  const deficits = [];
  for (const [i, ref] of supplyRefs) {
    const residual = ref.capacity - ref.flow;
    if (residual > 0) deficits.push({ node: nodes[i], amount: residual });
  }
  return {
    feasible: false,
    deficits,
    cut: { nodes: cutNodes, lowerOut, upperIn, violation: lowerOut - upperIn },
  };
}

module.exports = { solveCirculation, Dinic };
