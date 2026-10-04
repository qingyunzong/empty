interface Edge {
  to: number;
  rev: number;
  cap: number;
  cost: number;
}

export class MinCostMaxFlow {
  private readonly graph: Edge[][];

  constructor(private readonly size: number) {
    this.graph = Array.from({ length: size }, () => []);
  }

  addEdge(from: number, to: number, cap: number, cost: number): number {
    const fwd: Edge = { to, rev: this.graph[to].length, cap, cost };
    const bwd: Edge = { to: from, rev: this.graph[from].length, cap: 0, cost: -cost };
    this.graph[from].push(fwd);
    this.graph[to].push(bwd);
    return this.graph[from].length - 1;
  }

  residualCap(from: number, index: number): number {
    return this.graph[from][index].cap;
  }

  run(source: number, sink: number): { flow: number; cost: number } {
    const n = this.size;
    const potential = new Array<number>(n).fill(0);
    let flow = 0;
    let cost = 0;
    for (;;) {
      const dist = new Array<number>(n).fill(Infinity);
      const prevNode = new Array<number>(n).fill(-1);
      const prevEdge = new Array<number>(n).fill(-1);
      const done = new Array<boolean>(n).fill(false);
      dist[source] = 0;
      for (;;) {
        let v = -1;
        for (let i = 0; i < n; i++) {
          if (!done[i] && dist[i] < Infinity && (v < 0 || dist[i] < dist[v])) v = i;
        }
        if (v < 0) break;
        done[v] = true;
        const edges = this.graph[v];
        for (let ei = 0; ei < edges.length; ei++) {
          const e = edges[ei];
          if (e.cap <= 0) continue;
          const nd = dist[v] + e.cost + potential[v] - potential[e.to];
          if (nd < dist[e.to]) {
            dist[e.to] = nd;
            prevNode[e.to] = v;
            prevEdge[e.to] = ei;
          }
        }
      }
      if (dist[sink] === Infinity) break;
      for (let i = 0; i < n; i++) {
        if (dist[i] < Infinity) potential[i] += dist[i];
      }
      let d = Infinity;
      for (let v = sink; v !== source; v = prevNode[v]) {
        d = Math.min(d, this.graph[prevNode[v]][prevEdge[v]].cap);
      }
      for (let v = sink; v !== source; v = prevNode[v]) {
        const e = this.graph[prevNode[v]][prevEdge[v]];
        e.cap -= d;
        this.graph[v][e.rev].cap += d;
        cost += d * e.cost;
      }
      flow += d;
    }
    return { flow, cost };
  }
}
