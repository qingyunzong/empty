import { NormalizedSpec } from "./graph";

export interface PathCandidate {
  nodes: string[];
  maxEdgeCost: number;
  totalCost: number;
}

export interface SolveResult {
  found: boolean;
  best: PathCandidate | null;
  /** start->end simple paths within the node limit (before checkpoint filter). */
  simplePathCount: number;
  /** of those, the ones visiting every checkpoint. */
  feasiblePathCount: number;
}

function compareNumericChunks(a: string, b: string): number {
  const na = a.replace(/^0+/, "") || "0";
  const nb = b.replace(/^0+/, "") || "0";
  if (na.length !== nb.length) return na.length - nb.length;
  if (na !== nb) return na < nb ? -1 : 1;
  return 0;
}

/** Natural order: digit runs compare numerically ("N2" < "N10"), else bytewise. */
export function compareNodeIds(a: string, b: string): number {
  if (a === b) return 0;
  const ca = a.match(/\d+|\D+/g) ?? [];
  const cb = b.match(/\d+|\D+/g) ?? [];
  const shared = Math.min(ca.length, cb.length);
  for (let i = 0; i < shared; i++) {
    const x = ca[i]!;
    const y = cb[i]!;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = compareNumericChunks(x, y);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (ca.length !== cb.length) return ca.length - cb.length;
  return a < b ? -1 : 1;
}

/** Element-wise ID order; a strict prefix sorts before its extension. */
export function compareIdSequences(a: readonly string[], b: readonly string[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const d = compareNodeIds(a[i]!, b[i]!);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** Priority: 1) smaller max edge cost, 2) smaller total cost, 3) smaller ID sequence. */
export function compareCandidates(a: PathCandidate, b: PathCandidate): number {
  if (a.maxEdgeCost !== b.maxEdgeCost) return a.maxEdgeCost - b.maxEdgeCost;
  if (a.totalCost !== b.totalCost) return a.totalCost - b.totalCost;
  return compareIdSequences(a.nodes, b.nodes);
}

/**
 * Exhaustively enumerates simple paths start->end with at most maxNodes nodes
 * (no repeated nodes), keeps those visiting every checkpoint, and returns the
 * best one under compareCandidates.
 */
export function solve(spec: NormalizedSpec): SolveResult {
  // A path is a node sequence, so parallel edges between the same ordered
  // pair collapse to the cheapest one.
  const adjacency = new Map<string, Map<string, number>>();
  const addEdge = (from: string, to: string, cost: number): void => {
    let neighbors = adjacency.get(from);
    if (!neighbors) {
      neighbors = new Map();
      adjacency.set(from, neighbors);
    }
    const prev = neighbors.get(to);
    if (prev === undefined || cost < prev) neighbors.set(to, cost);
  };
  for (const edge of spec.edges) {
    addEdge(edge.from, edge.to, edge.cost);
    if (!spec.directed) addEdge(edge.to, edge.from, edge.cost);
  }

  const checkpoints = new Set(spec.checkpoints);
  let simplePathCount = 0;
  let feasiblePathCount = 0;
  let best: PathCandidate | null = null;

  const visited = new Set<string>([spec.start]);
  const path: string[] = [spec.start];
  let runningTotal = 0;
  let runningMax = -Infinity;

  const finish = (): void => {
    simplePathCount++;
    for (const cp of checkpoints) {
      if (!visited.has(cp)) return;
    }
    feasiblePathCount++;
    const candidate: PathCandidate = {
      nodes: [...path],
      maxEdgeCost: runningMax === -Infinity ? 0 : runningMax,
      totalCost: runningTotal,
    };
    if (best === null || compareCandidates(candidate, best) < 0) best = candidate;
  };

  const dfs = (node: string): void => {
    if (node === spec.end) {
      finish();
      return;
    }
    if (path.length >= spec.maxNodes) return;
    for (const [to, cost] of adjacency.get(node) ?? []) {
      if (visited.has(to)) continue;
      visited.add(to);
      path.push(to);
      const prevTotal = runningTotal;
      const prevMax = runningMax;
      runningTotal += cost;
      runningMax = Math.max(runningMax, cost);
      dfs(to);
      runningTotal = prevTotal;
      runningMax = prevMax;
      path.pop();
      visited.delete(to);
    }
  };

  dfs(spec.start);

  return { found: best !== null, best, simplePathCount, feasiblePathCount };
}
