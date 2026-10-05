/**
 * Circulation with lower and upper bounds.
 *
 * Feasibility is decided by the classical reduction to max flow:
 * every edge (u, v) with bounds [lower, upper] contributes `lower` to the
 * demand of v and `-lower` to the demand of u, and keeps residual capacity
 * `upper - lower`. A super source feeds nodes with positive demand and a
 * super sink drains nodes with negative demand. A feasible circulation
 * exists iff the max flow saturates every super-source arc. When it does
 * not, the reachable set of the residual graph yields a min-cut
 * certificate: a set X of nodes whose inbound lower bounds exceed the
 * outbound upper bounds (Hoffman's circulation condition).
 */

class Dinic {
  constructor(size) {
    this.graph = Array.from({ length: size }, () => []);
  }

  addArc(from, to, cap) {
    const forward = { to, rev: this.graph[to].length, cap, orig: cap };
    const backward = { to: from, rev: this.graph[from].length, cap: 0, orig: 0 };
    this.graph[from].push(forward);
    this.graph[to].push(backward);
    return forward;
  }

  maxflow(source, sink) {
    const { graph } = this;
    const size = graph.length;
    const level = new Array(size);
    const next = new Array(size);
    let total = 0;
    for (;;) {
      level.fill(-1);
      level[source] = 0;
      const queue = [source];
      for (let head = 0; head < queue.length; head++) {
        const u = queue[head];
        for (const arc of graph[u]) {
          if (arc.cap > 0 && level[arc.to] < 0) {
            level[arc.to] = level[u] + 1;
            queue.push(arc.to);
          }
        }
      }
      if (level[sink] < 0) return total;
      next.fill(0);
      let pushed;
      while ((pushed = this.#push(source, sink, Infinity, level, next)) > 0) {
        total += pushed;
      }
    }
  }

  #push(u, sink, f, level, next) {
    if (u === sink) return f;
    const arcs = this.graph[u];
    for (; next[u] < arcs.length; next[u]++) {
      const arc = arcs[next[u]];
      if (arc.cap > 0 && level[arc.to] === level[u] + 1) {
        const d = this.#push(arc.to, sink, Math.min(f, arc.cap), level, next);
        if (d > 0) {
          arc.cap -= d;
          this.graph[arc.to][arc.rev].cap += d;
          return d;
        }
      }
    }
    return 0;
  }
}

/**
 * @param {string[]} nodeNames node names (any order)
 * @param {Array<{id:string, from:string, to:string, lower:number, upper:number}>} edges
 * @returns {{feasible:true, flow:Object<string,number>} |
 *           {feasible:false, deficitNodes:string[],
 *            certificate:{cut:string[], lowerBoundIn:number, upperBoundOut:number, deficit:number}}}
 */
export function checkCirculation(nodeNames, edges) {
  const index = new Map(nodeNames.map((name, i) => [name, i]));
  const n = nodeNames.length;
  const SOURCE = n;
  const SINK = n + 1;
  const dinic = new Dinic(n + 2);
  const demand = new Array(n).fill(0);

  const arcs = edges.map((edge) => {
    const u = index.get(edge.from);
    const v = index.get(edge.to);
    demand[u] -= edge.lower;
    demand[v] += edge.lower;
    return dinic.addArc(u, v, edge.upper - edge.lower);
  });

  let totalDemand = 0;
  for (let i = 0; i < n; i++) {
    if (demand[i] > 0) {
      dinic.addArc(SOURCE, i, demand[i]);
      totalDemand += demand[i];
    } else if (demand[i] < 0) {
      dinic.addArc(i, SINK, -demand[i]);
    }
  }

  const flow = dinic.maxflow(SOURCE, SINK);

  if (flow === totalDemand) {
    const settlement = {};
    edges.forEach((edge, i) => {
      settlement[edge.id] = edge.lower + (arcs[i].orig - arcs[i].cap);
    });
    return { feasible: true, flow: settlement };
  }

  const seen = new Array(n + 2).fill(false);
  seen[SOURCE] = true;
  const stack = [SOURCE];
  while (stack.length > 0) {
    const u = stack.pop();
    for (const arc of dinic.graph[u]) {
      if (arc.cap > 0 && !seen[arc.to]) {
        seen[arc.to] = true;
        stack.push(arc.to);
      }
    }
  }

  const cut = nodeNames.filter((_, i) => seen[i]);
  const inCut = new Set(cut);
  let lowerBoundIn = 0;
  let upperBoundOut = 0;
  for (const edge of edges) {
    const fromIn = inCut.has(edge.from);
    const toIn = inCut.has(edge.to);
    if (toIn && !fromIn) lowerBoundIn += edge.lower;
    if (fromIn && !toIn) upperBoundOut += edge.upper;
  }

  return {
    feasible: false,
    deficitNodes: cut,
    certificate: {
      cut,
      lowerBoundIn,
      upperBoundOut,
      deficit: lowerBoundIn - upperBoundOut,
    },
  };
}
