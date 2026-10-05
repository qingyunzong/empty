import { InputError, MAX_AMOUNT, edgeCost, marginalCost, validateNetwork } from "./graph";
import { verifyCertificate } from "./certificate";
import { EdgeFlow, NetworkSpec, SolveResult } from "./types";

interface Arc {
  to: number;
  rev: number;
  cap: number;
  cost: number;
  /** Index of the originating edge for forward arcs, -1 for residual arcs. */
  edge: number;
}

type Adj = Arc[][];

const INF = Number.POSITIVE_INFINITY;

function addArc(adj: Adj, from: number, to: number, cap: number, cost: number, edge: number): void {
  const fwd: Arc = { to, rev: adj[to]!.length, cap, cost, edge };
  const rev: Arc = { to: from, rev: adj[from]!.length, cap: 0, cost: -cost, edge: -1 };
  adj[from]!.push(fwd);
  adj[to]!.push(rev);
}

/**
 * Expand piecewise fees into unit-capacity arcs. No edge ever needs to carry
 * more than MAX_AMOUNT units (the source can emit at most that many), so
 * segments are truncated there.
 */
function buildResidual(spec: NetworkSpec, nodeIndex: Map<string, number>): Adj {
  const adj: Adj = spec.nodes!.map(() => []);
  for (let i = 0; i < spec.edges.length; i++) {
    const edge = spec.edges[i]!;
    const u = nodeIndex.get(edge.from)!;
    const v = nodeIndex.get(edge.to)!;
    const effectiveCap = Math.min(edge.capacity, MAX_AMOUNT);
    for (let k = 1; k <= effectiveCap; k++) {
      addArc(adj, u, v, 1, marginalCost(edge.segments, k), i);
    }
  }
  return adj;
}

/**
 * Shortest distances from a super-source connected to every node with a
 * zero-cost arc (plain Bellman-Ford with all distances starting at 0).
 * Throws when the residual graph contains a negative cycle.
 */
function superSourcePotentials(adj: Adj): number[] {
  const n = adj.length;
  const dist = new Array<number>(n).fill(0);
  for (let iter = 0; iter < n; iter++) {
    let relaxed = false;
    for (let u = 0; u < n; u++) {
      for (const arc of adj[u]!) {
        if (arc.cap > 0 && dist[arc.to]! > dist[u]! + arc.cost) {
          if (iter === n - 1) {
            throw new InputError("negative-cost cycle detected in the residual graph");
          }
          dist[arc.to] = dist[u]! + arc.cost;
          relaxed = true;
        }
      }
    }
    if (!relaxed) break;
  }
  return dist;
}

function dijkstra(
  adj: Adj,
  source: number,
  potential: number[]
): { dist: number[]; prevNode: number[]; prevArc: number[] } {
  const n = adj.length;
  const dist = new Array<number>(n).fill(INF);
  const prevNode = new Array<number>(n).fill(-1);
  const prevArc = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[source] = 0;
  for (;;) {
    let u = -1;
    let best = INF;
    for (let i = 0; i < n; i++) {
      if (!done[i]! && dist[i]! < best) {
        best = dist[i]!;
        u = i;
      }
    }
    if (u === -1) break;
    done[u] = true;
    const arcs = adj[u]!;
    for (let a = 0; a < arcs.length; a++) {
      const arc = arcs[a]!;
      if (arc.cap <= 0) continue;
      const reduced = arc.cost + potential[u]! - potential[arc.to]!;
      if (dist[arc.to]! > dist[u]! + reduced) {
        dist[arc.to] = dist[u]! + reduced;
        prevNode[arc.to] = u;
        prevArc[arc.to] = a;
      }
    }
  }
  return { dist, prevNode, prevArc };
}

interface SspOutcome {
  adj: Adj;
  /** Min cost of exactly k units, for k = 0..flow. */
  costAt: number[];
  flow: number;
}

/** Successive shortest paths: min-cost flow of every value up to `amount`. */
function runSsp(spec: NetworkSpec, nodeIndex: Map<string, number>, amount: number): SspOutcome {
  const adj = buildResidual(spec, nodeIndex);
  const s = nodeIndex.get(spec.source)!;
  const t = nodeIndex.get(spec.sink)!;
  const potential = superSourcePotentials(adj);
  const costAt = [0];
  let flow = 0;
  while (flow < amount) {
    const { dist, prevNode, prevArc } = dijkstra(adj, s, potential);
    if (dist[t] === INF) break;
    for (let v = 0; v < adj.length; v++) {
      if (dist[v]! < INF) potential[v] = potential[v]! + dist[v]!;
    }
    let bottleneck = amount - flow;
    for (let v = t; v !== s; v = prevNode[v]!) {
      bottleneck = Math.min(bottleneck, adj[prevNode[v]!]![prevArc[v]!]!.cap);
    }
    const pathCost = potential[t]! - potential[s]!;
    for (let v = t; v !== s; v = prevNode[v]!) {
      const arc = adj[prevNode[v]!]![prevArc[v]!]!;
      arc.cap -= bottleneck;
      adj[v]![arc.rev]!.cap += bottleneck;
    }
    for (let k = 0; k < bottleneck; k++) {
      costAt.push(costAt[costAt.length - 1]! + pathCost);
    }
    flow += bottleneck;
  }
  return { adj, costAt, flow };
}

function extractEdgeFlows(spec: NetworkSpec, nodeIndex: Map<string, number>, adj: Adj): EdgeFlow[] {
  const used = new Array<number>(spec.edges.length).fill(0);
  for (let u = 0; u < adj.length; u++) {
    for (const arc of adj[u]!) {
      if (arc.edge >= 0 && arc.cap === 0) used[arc.edge]!++;
    }
  }
  return spec.edges.map((edge, i) => ({
    edge: i,
    from: edge.from,
    to: edge.to,
    flow: used[i]!,
    cost: edgeCost(edge.segments, used[i]!),
  }));
}

export function solve(rawSpec: NetworkSpec): SolveResult {
  const spec = validateNetwork(rawSpec);
  const nodeIndex = new Map<string, number>(spec.nodes!.map((name, i) => [name, i]));
  const mode = spec.atMost ? "at-most" : "exact";

  const first = runSsp(spec, nodeIndex, spec.amount);
  let target = spec.amount;
  let costByAmount: number[] | undefined;
  if (spec.atMost) {
    costByAmount = first.costAt.slice();
    let bestCost = Infinity;
    for (let k = 0; k < first.costAt.length; k++) {
      if (first.costAt[k]! < bestCost) {
        bestCost = first.costAt[k]!;
        target = k;
      }
    }
  } else if (first.flow < spec.amount) {
    return {
      status: "infeasible",
      mode,
      requested: spec.amount,
      sent: 0,
      totalCost: 0,
      maxFlow: first.flow,
      flows: [],
      potentials: {},
      certificate: {
        valid: false,
        checks: [
          {
            name: "feasibility",
            ok: false,
            detail: `requested ${spec.amount} units but max flow is ${first.flow}`,
          },
        ],
      },
    };
  }

  const outcome = target === first.flow ? first : runSsp(spec, nodeIndex, target);
  const flows = extractEdgeFlows(spec, nodeIndex, outcome.adj);
  const totalCost = flows.reduce((sum, f) => sum + f.cost, 0);

  const finalPotential = superSourcePotentials(outcome.adj);
  const potentials: Record<string, number> = {};
  for (const [name, idx] of nodeIndex) potentials[name] = finalPotential[idx]!;

  const certificate = verifyCertificate(spec, flows, potentials, target, totalCost);

  return {
    status: "optimal",
    mode,
    requested: spec.amount,
    sent: target,
    totalCost,
    costByAmount,
    flows,
    potentials,
    certificate,
  };
}
