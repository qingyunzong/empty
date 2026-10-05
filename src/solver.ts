import { Problem } from "./model";

export class NegativeCycleError extends Error {
  constructor() {
    super("input graph contains a negative-cost cycle (forbidden)");
    this.name = "NegativeCycleError";
  }
}

/** One unit-capacity-priced arc obtained by expanding an edge segment. */
interface Arc {
  from: number;
  to: number;
  cap: number; // residual capacity
  cost: number; // fee per unit
  edge: number; // index into problem.edges
  segment: number; // index into edge.segments
  flow: number;
}

export interface EdgeFlow {
  from: string;
  to: string;
  flow: number;
  cost: number;
}

export interface CertificateCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Certificate {
  valid: boolean;
  checks: CertificateCheck[];
}

export interface SolveResult {
  status: "ok" | "infeasible";
  amount: number;
  minCost?: number;
  flows?: EdgeFlow[];
  /** Node potentials pi with reduced cost >= 0 on every residual arc. */
  potentials?: Record<string, number>;
  certificate?: Certificate;
}

interface BuiltGraph {
  nodes: string[];
  index: Map<string, number>;
  arcs: Arc[];
}

function buildGraph(problem: Problem): BuiltGraph {
  const index = new Map<string, number>();
  const nodes: string[] = [];
  const nodeId = (name: string): number => {
    let id = index.get(name);
    if (id === undefined) {
      id = nodes.length;
      index.set(name, id);
      nodes.push(name);
    }
    return id;
  };
  // Register endpoints up front so an isolated source/sink is handled as
  // "infeasible" rather than crashing the index lookup.
  nodeId(problem.source);
  nodeId(problem.sink);
  const arcs: Arc[] = [];
  problem.edges.forEach((edge, edgeIdx) => {
    const from = nodeId(edge.from);
    const to = nodeId(edge.to);
    edge.segments.forEach((seg, segIdx) => {
      arcs.push({ from, to, cap: seg.capacity, cost: seg.cost, edge: edgeIdx, segment: segIdx, flow: 0 });
    });
  });
  return { nodes, index, arcs };
}

/**
 * Bellman-Ford from a virtual super-source connected to every node with a
 * zero-cost arc (all distances start at 0). Detects negative cycles among
 * arcs with positive residual capacity and yields initial potentials h with
 * h[v] <= h[u] + c(u,v) for every such arc.
 */
function initialPotentials(g: BuiltGraph): number[] {
  const n = g.nodes.length;
  const h = new Array<number>(n).fill(0);
  for (let iter = 0; iter < n; iter++) {
    let updated = false;
    for (const a of g.arcs) {
      if (a.cap <= 0) continue;
      const from = h[a.from]!;
      const to = h[a.to]!;
      if (to > from + a.cost) {
        if (iter === n - 1) throw new NegativeCycleError();
        h[a.to] = from + a.cost;
        updated = true;
      }
    }
    if (!updated) break;
  }
  return h;
}

/**
 * Optimality-certificate potentials computed on the FINAL residual graph:
 * Bellman-Ford from a virtual super-source (all distances start at 0) yields
 * pi with pi[v] <= pi[u] + c(u,v) on every residual arc, i.e. all reduced
 * costs are non-negative. The SSP-internal potentials are not reused here
 * because they are only maintained on nodes reachable from the source.
 * A negative cycle at this point would mean the flow is not optimal, which
 * the solver invariant rules out — treat it as an internal error.
 */
function certificatePotentials(g: BuiltGraph): number[] {
  const n = g.nodes.length;
  const pi = new Array<number>(n).fill(0);
  const res = residualArcs(g);
  for (let iter = 0; iter < n; iter++) {
    let updated = false;
    for (const r of res) {
      if (pi[r.to]! > pi[r.from]! + r.cost) {
        if (iter === n - 1)
          throw new Error("internal error: negative cycle in residual graph of solved flow");
        pi[r.to] = pi[r.from]! + r.cost;
        updated = true;
      }
    }
    if (!updated) break;
  }
  return pi;
}

/** Residual arcs of the current flow: forward (cap>0) and backward (flow>0). */
function residualArcs(g: BuiltGraph): Array<{ from: number; to: number; cost: number; arc: Arc; forward: boolean }> {
  const out: Array<{ from: number; to: number; cost: number; arc: Arc; forward: boolean }> = [];
  for (const a of g.arcs) {
    if (a.cap > 0) out.push({ from: a.from, to: a.to, cost: a.cost, arc: a, forward: true });
    if (a.flow > 0) out.push({ from: a.to, to: a.from, cost: -a.cost, arc: a, forward: false });
  }
  return out;
}

/** Dijkstra on reduced costs; returns distances and predecessor residual arcs. */
function dijkstra(
  g: BuiltGraph,
  s: number,
  h: number[]
): { dist: number[]; prev: Array<{ arc: Arc; forward: boolean } | null> } {
  const n = g.nodes.length;
  const dist = new Array<number>(n).fill(Infinity);
  const prev: Array<{ arc: Arc; forward: boolean } | null> = new Array(n).fill(null);
  const done = new Array<boolean>(n).fill(false);
  dist[s] = 0;
  const res = residualArcs(g);
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i]! && dist[i]! < best) {
        best = dist[i]!;
        u = i;
      }
    }
    if (u === -1) break;
    done[u] = true;
    for (const r of res) {
      if (r.from !== u) continue;
      const rc = r.cost + h[r.from]! - h[r.to]!; // >= 0 by invariant
      const nd = dist[u]! + rc;
      if (nd < dist[r.to]!) {
        dist[r.to] = nd;
        prev[r.to] = { arc: r.arc, forward: r.forward };
      }
    }
  }
  return { dist, prev };
}

/** Verify optimality certificate: feasibility + non-negative reduced costs. */
export function verifyCertificate(
  problem: Problem,
  g: BuiltGraph,
  potentials: number[]
): Certificate {
  const checks: CertificateCheck[] = [];
  const s = g.index.get(problem.source)!;
  const t = g.index.get(problem.sink)!;

  // cap is residual capacity, so 0 <= flow and 0 <= cap means the original
  // segment capacity (cap + flow) is respected.
  const capOk = g.arcs.every((a) => a.flow >= 0 && a.cap >= 0);
  checks.push({
    name: "capacity",
    ok: capOk,
    detail: "0 <= flow <= capacity on every segment arc",
  });

  const balance = new Array<number>(g.nodes.length).fill(0);
  for (const a of g.arcs) {
    balance[a.from]! -= a.flow;
    balance[a.to]! += a.flow;
  }
  let consOk = true;
  for (let v = 0; v < g.nodes.length; v++) {
    const expected = v === s ? -problem.amount : v === t ? problem.amount : 0;
    if (balance[v]! !== expected) consOk = false;
  }
  checks.push({
    name: "conservation",
    ok: consOk,
    detail: `source net outflow = sink net inflow = ${problem.amount}; all other nodes balanced`,
  });

  let rcOk = true;
  let worst = 0;
  for (const r of residualArcs(g)) {
    const rc = r.cost + potentials[r.from]! - potentials[r.to]!;
    if (rc < worst) worst = rc;
    if (rc < 0) rcOk = false;
  }
  checks.push({
    name: "reduced-costs",
    ok: rcOk,
    detail: rcOk
      ? "c(u,v) + pi(u) - pi(v) >= 0 on every residual arc (min reduced cost = " + worst + ")"
      : "negative reduced cost on a residual arc: flow is not optimal",
  });

  return { valid: checks.every((c) => c.ok), checks };
}

/**
 * Min-cost flow of exactly `problem.amount` integer units from source to sink.
 * Costs may be negative, but the input must not contain a negative-cost cycle
 * (checked up front; throws NegativeCycleError).
 */
export function solve(problem: Problem): SolveResult {
  const g = buildGraph(problem);
  const s = g.index.get(problem.source)!;
  const t = g.index.get(problem.sink)!;

  const h = initialPotentials(g); // throws on negative cycle

  let sent = 0;
  while (sent < problem.amount) {
    const { dist, prev } = dijkstra(g, s, h);
    if (dist[t] === Infinity) {
      return { status: "infeasible", amount: problem.amount };
    }
    for (let v = 0; v < g.nodes.length; v++) {
      if (dist[v]! < Infinity) h[v] = h[v]! + dist[v]!;
    }
    // Bottleneck along the shortest path.
    let add = problem.amount - sent;
    for (let v = t; v !== s; ) {
      const p = prev[v]!;
      add = Math.min(add, p.forward ? p.arc.cap : p.arc.flow);
      v = p.forward ? p.arc.from : p.arc.to;
    }
    for (let v = t; v !== s; ) {
      const p = prev[v]!;
      if (p.forward) {
        p.arc.flow += add;
        p.arc.cap -= add;
      } else {
        p.arc.flow -= add;
        p.arc.cap += add;
      }
      v = p.forward ? p.arc.from : p.arc.to;
    }
    sent += add;
  }

  const minCost = g.arcs.reduce((acc, a) => acc + a.flow * a.cost, 0);

  // Aggregate flows per input edge.
  const flows: EdgeFlow[] = [];
  problem.edges.forEach((edge, i) => {
    const total = g.arcs.filter((a) => a.edge === i).reduce((acc, a) => acc + a.flow, 0);
    if (total === 0) return;
    let cost = 0;
    let remaining = total;
    for (const seg of edge.segments) {
      const take = Math.min(remaining, seg.capacity);
      cost += take * seg.cost;
      remaining -= take;
    }
    flows.push({ from: edge.from, to: edge.to, flow: total, cost });
  });

  const pi = certificatePotentials(g);
  const potentials: Record<string, number> = {};
  g.nodes.forEach((name, i) => {
    potentials[name] = pi[i]!;
  });

  const certificate = verifyCertificate(problem, g, pi);

  return { status: "ok", amount: problem.amount, minCost, flows, potentials, certificate };
}
