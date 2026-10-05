import type { AttributedSegment, Shift } from './attribute.js';

export const MAX_TIME = 30;
export const MAX_SHIFTS = 12;

export interface ConstrainedShift extends Shift {
  maxWork: number;
  minRest: number;
}

export interface RestCertificate {
  shiftId: number;
  worked: number;
  rest: number;
  maxWork: number;
  minRest: number;
}

export interface AllocationResult {
  segments: AttributedSegment[];
  certificates: RestCertificate[];
  coverage: number;
  benefit: number;
}

export function effectiveCap(shift: ConstrainedShift): number {
  const duration = shift.end - shift.start;
  return Math.min(shift.maxWork, duration - shift.minRest);
}

export function validateConstrainedShifts(shifts: ConstrainedShift[]): void {
  if (shifts.length > MAX_SHIFTS) {
    throw new RangeError(`at most ${MAX_SHIFTS} shifts, got ${shifts.length}`);
  }
  const seen = new Set<number>();
  for (const s of shifts) {
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end)) {
      throw new RangeError(`shift ${s.id}: endpoints must be integers`);
    }
    if (s.start < 0 || s.end > MAX_TIME || s.start >= s.end) {
      throw new RangeError(
        `shift ${s.id}: endpoints must satisfy 0 <= start < end <= ${MAX_TIME}`,
      );
    }
    if (!Number.isInteger(s.maxWork) || s.maxWork < 0) {
      throw new RangeError(`shift ${s.id}: maxWork must be a non-negative integer`);
    }
    if (!Number.isInteger(s.minRest) || s.minRest < 0) {
      throw new RangeError(`shift ${s.id}: minRest must be a non-negative integer`);
    }
    if (s.minRest > s.end - s.start) {
      throw new RangeError(`shift ${s.id}: minRest exceeds shift duration`);
    }
    if (seen.has(s.id)) {
      throw new RangeError(`duplicate shift id ${s.id}`);
    }
    seen.add(s.id);
  }
}

interface FlowEdge {
  to: number;
  rev: number;
  cap: number;
  cost: number;
}

class MinCostFlow {
  private readonly graph: FlowEdge[][] = [];

  addNode(): number {
    this.graph.push([]);
    return this.graph.length - 1;
  }

  addEdge(from: number, to: number, cap: number, cost: number): number {
    const fwd: FlowEdge = { to, rev: this.graph[to].length, cap, cost };
    const rev: FlowEdge = { to: from, rev: this.graph[from].length, cap: 0, cost: -cost };
    this.graph[from].push(fwd);
    this.graph[to].push(rev);
    return this.graph[from].length - 1;
  }

  edgeAt(node: number, index: number): FlowEdge {
    return this.graph[node][index];
  }

  minCostMaxFlow(source: number, sink: number): { flow: number; cost: number } {
    const nodeCount = this.graph.length;
    let flow = 0;
    let cost = 0;
    for (;;) {
      const dist = new Array<number>(nodeCount).fill(Infinity);
      const inQueue = new Array<boolean>(nodeCount).fill(false);
      const prevNode = new Array<number>(nodeCount).fill(-1);
      const prevEdge = new Array<number>(nodeCount).fill(-1);
      dist[source] = 0;
      const queue: number[] = [source];
      inQueue[source] = true;
      while (queue.length > 0) {
        const u = queue.shift() as number;
        inQueue[u] = false;
        const edges = this.graph[u];
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          if (e.cap <= 0) continue;
          const nd = dist[u] + e.cost;
          if (nd < dist[e.to]) {
            dist[e.to] = nd;
            prevNode[e.to] = u;
            prevEdge[e.to] = i;
            if (!inQueue[e.to]) {
              queue.push(e.to);
              inQueue[e.to] = true;
            }
          }
        }
      }
      if (prevNode[sink] === -1) break;
      let add = Infinity;
      for (let v = sink; v !== source; v = prevNode[v]) {
        add = Math.min(add, this.graph[prevNode[v]][prevEdge[v]].cap);
      }
      for (let v = sink; v !== source; v = prevNode[v]) {
        const e = this.graph[prevNode[v]][prevEdge[v]];
        e.cap -= add;
        this.graph[v][e.rev].cap += add;
      }
      flow += add;
      cost += add * dist[sink];
    }
    return { flow, cost };
  }
}

export function allocate(shifts: ConstrainedShift[]): AllocationResult {
  validateConstrainedShifts(shifts);
  const mcf = new MinCostFlow();
  const source = mcf.addNode();
  const slotNodes: number[] = [];
  for (let t = 0; t < MAX_TIME; t++) slotNodes.push(mcf.addNode());
  const shiftNodes = shifts.map(() => mcf.addNode());
  const sink = mcf.addNode();
  for (const slotNode of slotNodes) mcf.addEdge(source, slotNode, 1, 0);
  const slotEdgeRefs: { shiftIndex: number; edgeIndex: number }[][] = [];
  for (let t = 0; t < MAX_TIME; t++) {
    const refs: { shiftIndex: number; edgeIndex: number }[] = [];
    shifts.forEach((s, si) => {
      if (s.start <= t && t < s.end) {
        refs.push({ shiftIndex: si, edgeIndex: mcf.addEdge(slotNodes[t], shiftNodes[si], 1, 0) });
      }
    });
    slotEdgeRefs.push(refs);
  }
  shifts.forEach((s, si) => {
    mcf.addEdge(shiftNodes[si], sink, Math.max(0, effectiveCap(s)), -s.priority);
  });
  mcf.minCostMaxFlow(source, sink);

  const worked = new Array<number>(shifts.length).fill(0);
  const assignedSlots: number[][] = shifts.map(() => []);
  for (let t = 0; t < MAX_TIME; t++) {
    for (const ref of slotEdgeRefs[t]) {
      if (mcf.edgeAt(slotNodes[t], ref.edgeIndex).cap === 0) {
        worked[ref.shiftIndex]++;
        assignedSlots[ref.shiftIndex].push(t);
      }
    }
  }

  const segments: AttributedSegment[] = [];
  shifts.forEach((s, si) => {
    for (const t of assignedSlots[si]) {
      const last = segments[segments.length - 1];
      if (last && last.shiftId === s.id && last.end === t) {
        last.end = t + 1;
      } else {
        segments.push({ shiftId: s.id, start: t, end: t + 1 });
      }
    }
  });
  segments.sort((a, b) => a.start - b.start || a.shiftId - b.shiftId);

  const certificates: RestCertificate[] = shifts
    .map((s, si) => ({
      shiftId: s.id,
      worked: worked[si],
      rest: s.end - s.start - worked[si],
      maxWork: s.maxWork,
      minRest: s.minRest,
    }))
    .sort((a, b) => a.shiftId - b.shiftId);

  const coverage = worked.reduce((sum, w) => sum + w, 0);
  const benefit = shifts.reduce((sum, s, si) => sum + s.priority * worked[si], 0);
  return { segments, certificates, coverage, benefit };
}

export function exhaustiveAllocate(shifts: ConstrainedShift[]): {
  coverage: number;
  benefit: number;
} {
  validateConstrainedShifts(shifts);
  const caps = shifts.map((s) => Math.max(0, effectiveCap(s)));
  const slots: number[] = [];
  for (let t = 0; t < MAX_TIME; t++) {
    if (shifts.some((s) => s.start <= t && t < s.end)) slots.push(t);
  }
  const used = new Array<number>(shifts.length).fill(0);
  const maxPriority = Math.max(0, ...shifts.map((s) => s.priority));
  let bestCoverage = 0;
  let bestBenefit = 0;

  function dfs(i: number, coverage: number, benefit: number): void {
    const remaining = slots.length - i;
    if (coverage + remaining < bestCoverage) return;
    if (
      coverage + remaining === bestCoverage &&
      benefit + maxPriority * remaining <= bestBenefit
    ) {
      return;
    }
    if (i === slots.length) {
      if (coverage > bestCoverage || (coverage === bestCoverage && benefit > bestBenefit)) {
        bestCoverage = coverage;
        bestBenefit = benefit;
      }
      return;
    }
    const t = slots[i];
    dfs(i + 1, coverage, benefit);
    for (let si = 0; si < shifts.length; si++) {
      const s = shifts[si];
      if (s.start <= t && t < s.end && used[si] < caps[si]) {
        used[si]++;
        dfs(i + 1, coverage + 1, benefit + s.priority);
        used[si]--;
      }
    }
  }

  dfs(0, 0, 0);
  return { coverage: bestCoverage, benefit: bestBenefit };
}
