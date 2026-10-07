import type { Graph } from "./graph.js";
import type { PathStep } from "./pathCertificate.js";

/**
 * Certificate that the graph contains a negative cycle: a closed directed
 * walk whose total weight is negative. Verified independently of optimality
 * certificates (which cannot exist when such a cycle is reachable).
 */
export interface NegativeCycleCertificate {
  readonly steps: readonly PathStep[];
  readonly totalWeight: number;
}

export type NegativeCycleFailure = {
  readonly ok: false;
  /** Index of the first failing step; terminal mismatches use `steps.length`. */
  readonly position: number;
  readonly reason: string;
};

export type NegativeCycleResult = { readonly ok: true } | NegativeCycleFailure;

const fail = (position: number, reason: string): NegativeCycleFailure => ({
  ok: false,
  position,
  reason,
});

export function verifyNegativeCycleCertificate(
  graph: Graph,
  cert: NegativeCycleCertificate,
): NegativeCycleResult {
  const { steps, totalWeight } = cert;
  if (steps.length === 0) {
    return fail(0, "a cycle needs at least one edge");
  }

  let start: string | undefined;
  let current: string | undefined;
  let weight = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const edge = graph.getEdge(step.edgeId);
    if (edge === undefined) {
      return fail(i, `unknown edge: ${step.edgeId}`);
    }
    if (edge.version !== step.version) {
      return fail(
        i,
        `edge ${edge.id} version mismatch: certificate pins ${step.version}, graph has ${edge.version}`,
      );
    }
    if (current !== undefined && edge.from !== current) {
      return fail(i, `edge ${edge.id} starts at ${edge.from}, expected ${current}`);
    }
    start ??= edge.from;
    current = edge.to;
    weight += edge.weight;
  }

  if (current !== start) {
    return fail(steps.length, `walk ends at ${current}, does not close the cycle at ${start}`);
  }
  if (weight !== totalWeight) {
    return fail(steps.length, `declared weight ${totalWeight} does not match actual weight ${weight}`);
  }
  if (totalWeight >= 0) {
    return fail(steps.length, `cycle weight ${totalWeight} is not negative`);
  }
  return { ok: true };
}

/**
 * Finds a negative cycle with Bellman-Ford (zero-initialized, so cycles
 * unreachable from any particular source are still found) and returns it as
 * a certificate. Returns null when the graph has no negative cycle.
 */
export function generateNegativeCycleCertificate(graph: Graph): NegativeCycleCertificate | null {
  const nodes = graph.nodes();
  const edges = graph.edges();
  const dist = new Map<string, number>(nodes.map((n) => [n, 0]));
  const predecessor = new Map<string, string>();

  let relaxedOnLastRound: string | null = null;
  for (let round = 0; round < nodes.length; round++) {
    relaxedOnLastRound = null;
    for (const edge of edges) {
      if (dist.get(edge.from)! + edge.weight < dist.get(edge.to)!) {
        dist.set(edge.to, dist.get(edge.from)! + edge.weight);
        predecessor.set(edge.to, edge.id);
        relaxedOnLastRound = edge.to;
      }
    }
    if (relaxedOnLastRound === null) return null;
  }

  // Walk predecessors back |V| times to land inside the cycle, then collect it.
  let node = relaxedOnLastRound!;
  for (let i = 0; i < nodes.length; i++) {
    node = graph.getEdge(predecessor.get(node)!)!.from;
  }
  const cycleEdgeIds: string[] = [];
  const seen = new Set<string>();
  while (!seen.has(node)) {
    seen.add(node);
    const edgeId = predecessor.get(node)!;
    cycleEdgeIds.unshift(edgeId);
    node = graph.getEdge(edgeId)!.from;
  }

  const steps: PathStep[] = cycleEdgeIds.map((edgeId) => {
    const edge = graph.getEdge(edgeId)!;
    return { edgeId: edge.id, version: edge.version };
  });
  const totalWeight = cycleEdgeIds.reduce((sum, id) => sum + graph.getEdge(id)!.weight, 0);
  return { steps, totalWeight };
}
