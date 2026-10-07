/**
 * DAG critical-path scheduling.
 *
 * - Earliest start (ES) / latest start (LS) for every node.
 * - Multiple terminal (sink) nodes are treated as connected to a common
 *   virtual exit node via zero-duration edges.
 * - Zero-duration edges are legal.
 * - Incremental update of ES/LS after a single edge-duration change,
 *   verifiable against a full topological recompute.
 * - Longest-path certificate (a witness critical path).
 * - Shortest directed cycle reported when the graph is cyclic.
 */

export const EXIT_NODE = "__exit__";

export interface Edge {
  from: string;
  to: string;
  duration: number;
}

export interface Schedule {
  earliestStart: Map<string, number>;
  latestStart: Map<string, number>;
  makespan: number;
}

export interface Verification {
  consistent: boolean;
  mismatches: string[];
}

export interface IncrementalResult {
  schedule: Schedule;
  verification: Verification;
}

export interface LongestPathCertificate {
  /** Node ids from a source through a sink, ending at EXIT_NODE. */
  path: string[];
  /** Sum of edge durations along `path` (equals the makespan). */
  totalDuration: number;
}

export class CycleError extends Error {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(`Graph is cyclic; shortest cycle: ${cycle.join(" -> ")}`);
    this.name = "CycleError";
    this.cycle = cycle;
  }
}

export class DagScheduler {
  private readonly nodes = new Set<string>();
  /** from -> (to -> duration) */
  private readonly outEdges = new Map<string, Map<string, number>>();
  /** to -> (from -> duration) */
  private readonly inEdges = new Map<string, Map<string, number>>();
  private cached: Schedule | null = null;

  addNode(id: string): void {
    if (id === EXIT_NODE) {
      throw new Error(`"${EXIT_NODE}" is reserved for the virtual exit node`);
    }
    if (!this.nodes.has(id)) {
      this.nodes.add(id);
      this.outEdges.set(id, new Map());
      this.inEdges.set(id, new Map());
      this.cached = null;
    }
  }

  addEdge(from: string, to: string, duration: number): void {
    this.checkDuration(duration);
    this.addNode(from);
    this.addNode(to);
    this.outEdges.get(from)!.set(to, duration);
    this.inEdges.get(to)!.set(from, duration);
    this.cached = null;
  }

  hasEdge(from: string, to: string): boolean {
    return this.outEdges.get(from)?.has(to) ?? false;
  }

  edgeDuration(from: string, to: string): number {
    const d = this.outEdges.get(from)?.get(to);
    if (d === undefined) throw new Error(`No edge ${from} -> ${to}`);
    return d;
  }

  nodeIds(): string[] {
    return [...this.nodes];
  }

  edges(): Edge[] {
    const result: Edge[] = [];
    for (const [from, tos] of this.outEdges) {
      for (const [to, duration] of tos) result.push({ from, to, duration });
    }
    return result;
  }

  /** Current schedule, recomputing from scratch if the graph is dirty. */
  getSchedule(): Schedule {
    if (!this.cached) this.cached = this.computeFull();
    return this.cached;
  }

  /** Full topological recompute (Kahn + forward/backward passes). */
  recompute(): Schedule {
    this.cached = this.computeFull();
    return this.cached;
  }

  /**
   * Incrementally update ES/LS after changing one edge's duration.
   * Propagates ES forward from the edge head and LS backward from the
   * edge tail (plus all sinks, since the makespan may move), then
   * verifies the result against a full topological recompute.
   */
  updateDuration(from: string, to: string, duration: number): IncrementalResult {
    this.checkDuration(duration);
    const old = this.outEdges.get(from)?.get(to);
    if (old === undefined) throw new Error(`No edge ${from} -> ${to}`);
    const base = this.getSchedule(); // throws CycleError if cyclic
    this.outEdges.get(from)!.set(to, duration);
    this.inEdges.get(to)!.set(from, duration);

    const es = new Map(base.earliestStart);
    const ls = new Map(base.latestStart);

    // Forward pass: only descendants of `to` can change ES.
    this.propagate(es, [to], (x) => {
      let best = 0;
      for (const [p, w] of this.inEdges.get(x)!) best = Math.max(best, es.get(p)! + w);
      return best;
    }, (x) => this.outEdges.get(x)!.keys());

    const sinks = this.sinkIds();
    const makespan = sinks.reduce((m, s) => Math.max(m, es.get(s)!), 0);

    // Backward pass: ancestors of `from`, plus sinks (makespan may have moved).
    this.propagate(ls, [from, ...sinks], (x) => {
      const outs = this.outEdges.get(x)!;
      if (outs.size === 0) return makespan; // sink pinned to the exit
      let best = Infinity;
      for (const [s, w] of outs) best = Math.min(best, ls.get(s)! - w);
      return best;
    }, (x) => this.inEdges.get(x)!.keys());

    const incremental: Schedule = { earliestStart: es, latestStart: ls, makespan };
    this.cached = incremental;

    const full = this.computeFull();
    const verification = compareSchedules(incremental, full);
    return { schedule: incremental, verification };
  }

  /**
   * All critical edges: tight in both directions,
   * ES[u] + w == ES[v] and LS[u] + w == LS[v].
   * Includes the virtual zero-duration edges from tight sinks to the exit.
   */
  criticalEdges(): Edge[] {
    const s = this.getSchedule();
    const result: Edge[] = [];
    for (const e of this.edges()) {
      const esU = s.earliestStart.get(e.from)!;
      const esV = s.earliestStart.get(e.to)!;
      const lsU = s.latestStart.get(e.from)!;
      const lsV = s.latestStart.get(e.to)!;
      if (esU + e.duration === esV && lsU + e.duration === lsV) result.push(e);
    }
    for (const sink of this.sinkIds()) {
      if (s.earliestStart.get(sink)! === s.makespan && s.latestStart.get(sink)! === s.makespan) {
        result.push({ from: sink, to: EXIT_NODE, duration: 0 });
      }
    }
    return result;
  }

  /**
   * Witness longest path: a chain of tight edges from a source to the
   * virtual exit whose durations sum to the makespan.
   */
  longestPathCertificate(): LongestPathCertificate {
    const s = this.getSchedule();
    if (this.nodes.size === 0) return { path: [EXIT_NODE], totalDuration: 0 };

    let cur: string | undefined;
    for (const sink of this.sinkIds()) {
      if (s.earliestStart.get(sink)! === s.makespan) { cur = sink; break; }
    }
    if (cur === undefined) throw new Error("Internal error: no tight sink");

    const chain: string[] = [cur];
    while (true) {
      const esCur = s.earliestStart.get(cur)!;
      const lsCur = s.latestStart.get(cur)!;
      let next: string | undefined;
      for (const [p, w] of this.inEdges.get(cur)!) {
        if (s.earliestStart.get(p)! + w === esCur && s.latestStart.get(p)! + w === lsCur) {
          next = p;
          break;
        }
      }
      if (next === undefined) break; // reached a source
      chain.unshift(next);
      cur = next;
    }
    chain.push(EXIT_NODE);

    let total = 0;
    for (let i = 0; i + 1 < chain.length; i++) {
      total += chain[i + 1] === EXIT_NODE ? 0 : this.edgeDuration(chain[i]!, chain[i + 1]!);
    }
    return { path: chain, totalDuration: total };
  }

  /**
   * Shortest directed cycle (fewest edges), or null for a DAG.
   * BFS from every node; the cycle is returned as [v0, v1, ..., v0].
   */
  shortestCycle(): string[] | null {
    let best: string[] | null = null;
    for (const start of this.nodes) {
      const dist = new Map<string, number>([[start, 0]]);
      const parent = new Map<string, string>();
      const queue: string[] = [start];
      for (let head = 0; head < queue.length; head++) {
        const x = queue[head]!;
        for (const y of this.outEdges.get(x)!.keys()) {
          if (!dist.has(y)) {
            dist.set(y, dist.get(x)! + 1);
            parent.set(y, x);
            queue.push(y);
          }
        }
      }
      for (const p of this.inEdges.get(start)!.keys()) {
        const d = p === start ? 0 : dist.get(p);
        if (d === undefined) continue;
        const length = d + 1;
        if (best !== null && length >= best.length - 1) continue;
        const cycle: string[] = [start];
        if (p !== start) {
          const back: string[] = [];
          for (let x = p; x !== start; x = parent.get(x)!) back.unshift(x);
          cycle.push(...back);
        }
        cycle.push(start);
        best = cycle;
      }
    }
    return best;
  }

  // ---- internals -------------------------------------------------------

  private checkDuration(duration: number): void {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error(`Duration must be a finite number >= 0, got ${duration}`);
    }
  }

  private sinkIds(): string[] {
    const sinks: string[] = [];
    for (const id of this.nodes) {
      if (this.outEdges.get(id)!.size === 0) sinks.push(id);
    }
    return sinks;
  }

  private topoOrder(): string[] {
    const indeg = new Map<string, number>();
    for (const id of this.nodes) indeg.set(id, this.inEdges.get(id)!.size);
    const queue: string[] = [];
    for (const [id, d] of indeg) if (d === 0) queue.push(id);
    const order: string[] = [];
    for (let head = 0; head < queue.length; head++) {
      const x = queue[head]!;
      order.push(x);
      for (const y of this.outEdges.get(x)!.keys()) {
        const d = indeg.get(y)! - 1;
        indeg.set(y, d);
        if (d === 0) queue.push(y);
      }
    }
    if (order.length !== this.nodes.size) {
      throw new CycleError(this.shortestCycle() ?? []);
    }
    return order;
  }

  private computeFull(): Schedule {
    const order = this.topoOrder();
    const es = new Map<string, number>();
    for (const id of this.nodes) es.set(id, 0);
    for (const u of order) {
      for (const [v, w] of this.outEdges.get(u)!) {
        const cand = es.get(u)! + w;
        if (cand > es.get(v)!) es.set(v, cand);
      }
    }
    const sinks = this.sinkIds();
    const makespan = sinks.reduce((m, s) => Math.max(m, es.get(s)!), 0);
    const ls = new Map<string, number>();
    for (const id of this.nodes) ls.set(id, this.outEdges.get(id)!.size === 0 ? makespan : Infinity);
    for (let i = order.length - 1; i >= 0; i--) {
      const u = order[i]!;
      for (const [p, w] of this.inEdges.get(u)!) {
        const cand = ls.get(u)! - w;
        if (cand < ls.get(p)!) ls.set(p, cand);
      }
    }
    return { earliestStart: es, latestStart: ls, makespan };
  }

  /** Queue-based relaxation: recompute `value(x)`; on change, enqueue `neighbors(x)`. */
  private propagate(
    values: Map<string, number>,
    seeds: Iterable<string>,
    value: (x: string) => number,
    neighbors: (x: string) => Iterable<string>,
  ): void {
    const queue: string[] = [];
    const queued = new Set<string>();
    for (const s of seeds) {
      if (!queued.has(s)) { queued.add(s); queue.push(s); }
    }
    for (let head = 0; head < queue.length; head++) {
      const x = queue[head]!;
      queued.delete(x);
      const v = value(x);
      if (v !== values.get(x)) {
        values.set(x, v);
        for (const n of neighbors(x)) {
          if (!queued.has(n)) { queued.add(n); queue.push(n); }
        }
      }
    }
  }
}

function compareSchedules(a: Schedule, b: Schedule): Verification {
  const mismatches: string[] = [];
  if (a.makespan !== b.makespan) {
    mismatches.push(`makespan: incremental=${a.makespan} full=${b.makespan}`);
  }
  const ids = new Set([...a.earliestStart.keys(), ...b.earliestStart.keys()]);
  for (const id of ids) {
    const aes = a.earliestStart.get(id);
    const bes = b.earliestStart.get(id);
    if (aes !== bes) mismatches.push(`ES[${id}]: incremental=${aes} full=${bes}`);
    const als = a.latestStart.get(id);
    const bls = b.latestStart.get(id);
    if (als !== bls) mismatches.push(`LS[${id}]: incremental=${als} full=${bls}`);
  }
  return { consistent: mismatches.length === 0, mismatches };
}
