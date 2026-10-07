const EPS = 1e-9;

// Dinic max-flow with deterministic adjacency (insertion order).
export class Dinic {
  constructor() {
    this.adj = new Map(); // node -> array of edge objects touching it
    this.edges = [];      // all edge objects (forward and residual)
  }

  addNode(u) {
    if (!this.adj.has(u)) this.adj.set(u, []);
  }

  addEdge(u, v, cap) {
    this.addNode(u);
    this.addNode(v);
    const fwd = { from: u, to: v, cap, flow: 0, forward: true, rev: null };
    const bwd = { from: v, to: u, cap: 0, flow: 0, forward: false, rev: fwd };
    fwd.rev = bwd;
    this.edges.push(fwd, bwd);
    this.adj.get(u).push(fwd);
    this.adj.get(v).push(bwd);
    return fwd;
  }

  maxflow(s, t) {
    let total = 0;
    for (;;) {
      const level = new Map([[s, 0]]);
      const queue = [s];
      for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const e of this.adj.get(u)) {
          if (e.cap - e.flow > EPS && !level.has(e.to)) {
            level.set(e.to, level.get(u) + 1);
            queue.push(e.to);
          }
        }
      }
      if (!level.has(t)) break;
      const iter = new Map();
      const dfs = (u, f) => {
        if (u === t) return f;
        const edges = this.adj.get(u);
        let i = iter.get(u) ?? 0;
        while (i < edges.length) {
          const e = edges[i];
          if (e.cap - e.flow > EPS && level.get(e.to) === level.get(u) + 1) {
            const d = dfs(e.to, Math.min(f, e.cap - e.flow));
            if (d > EPS) {
              e.flow += d;
              e.rev.flow -= d;
              iter.set(u, i);
              return d;
            }
          }
          i++;
        }
        iter.set(u, i);
        return 0;
      };
      for (;;) {
        const f = dfs(s, Infinity);
        if (f <= EPS) break;
        total += f;
      }
    }
    return total;
  }

  // Nodes reachable from s in the residual graph (used for the min cut).
  reachableFrom(s) {
    const seen = new Set([s]);
    const queue = [s];
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi];
      for (const e of this.adj.get(u)) {
        if (e.cap - e.flow > EPS && !seen.has(e.to)) {
          seen.add(e.to);
          queue.push(e.to);
        }
      }
    }
    return seen;
  }
}

export { EPS };
