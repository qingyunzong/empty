export const EPS = 1e-9;

// Dinic max-flow with deterministic traversal: adjacency lists preserve
// insertion order, so the computed flow is a deterministic function of the
// order in which edges were added.
export class Dinic {
  constructor(nodeCount) {
    this.nodeCount = nodeCount;
    this.adj = Array.from({ length: nodeCount }, () => []);
    this.to = [];
    this.cap = [];
    this.userEdges = [];
  }

  addEdge(u, v, capacity) {
    const fwd = this.to.length;
    this.to.push(v);
    this.cap.push(capacity);
    this.adj[u].push(fwd);
    this.to.push(u);
    this.cap.push(0);
    this.adj[v].push(fwd + 1);
    this.userEdges.push(fwd);
    return this.userEdges.length - 1;
  }

  bfs(source, sink) {
    this.level = new Array(this.nodeCount).fill(-1);
    this.level[source] = 0;
    const queue = [source];
    for (let i = 0; i < queue.length; i++) {
      const u = queue[i];
      for (const e of this.adj[u]) {
        const v = this.to[e];
        if (this.cap[e] > EPS && this.level[v] === -1) {
          this.level[v] = this.level[u] + 1;
          queue.push(v);
        }
      }
    }
    return this.level[sink] !== -1;
  }

  dfs(u, sink, f) {
    if (u === sink) return f;
    const adj = this.adj[u];
    while (this.iter[u] < adj.length) {
      const e = adj[this.iter[u]];
      const v = this.to[e];
      if (this.cap[e] > EPS && this.level[v] === this.level[u] + 1) {
        const d = this.dfs(v, sink, Math.min(f, this.cap[e]));
        if (d > EPS) {
          this.cap[e] -= d;
          this.cap[e ^ 1] += d;
          return d;
        }
      }
      this.iter[u]++;
    }
    return 0;
  }

  maxFlow(source, sink) {
    let flow = 0;
    while (this.bfs(source, sink)) {
      this.iter = new Array(this.nodeCount).fill(0);
      let f;
      while ((f = this.dfs(source, sink, Infinity)) > EPS) flow += f;
    }
    return flow;
  }

  flowOn(userEdgeIndex) {
    return this.cap[this.userEdges[userEdgeIndex] ^ 1];
  }

  reachableFrom(source) {
    const seen = new Array(this.nodeCount).fill(false);
    seen[source] = true;
    const stack = [source];
    while (stack.length > 0) {
      const u = stack.pop();
      for (const e of this.adj[u]) {
        const v = this.to[e];
        if (this.cap[e] > EPS && !seen[v]) {
          seen[v] = true;
          stack.push(v);
        }
      }
    }
    return seen;
  }
}
