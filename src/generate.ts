import type { Edge, Graph } from './graph.ts';
import type {
  NegativeCycleCertificate,
  OptimalityCertificate,
  PathCertificate,
} from './verify.ts';

export interface Distances {
  kind: 'distances';
  dist: Map<string, number>;
  pred: Map<string, Edge>;
}

export interface NegativeCycleFound {
  kind: 'negative-cycle';
  certificate: NegativeCycleCertificate;
}

export type ShortestPathResult = Distances | NegativeCycleFound;

export function shortestPaths(graph: Graph, source: string): ShortestPathResult {
  const dist = new Map<string, number>(graph.nodes.map((node) => [node, Infinity]));
  if (!dist.has(source)) {
    throw new Error(`source node '${source}' is not in the graph`);
  }
  dist.set(source, 0);
  const pred = new Map<string, Edge>();
  let relaxed: Edge | null = null;
  for (let i = 0; i < graph.nodes.length; i++) {
    relaxed = null;
    for (const edge of graph.edges) {
      const from = dist.get(edge.from)!;
      if (from + edge.cost < dist.get(edge.to)!) {
        dist.set(edge.to, from + edge.cost);
        pred.set(edge.to, edge);
        relaxed = edge;
      }
    }
    if (relaxed === null) {
      break;
    }
  }
  if (relaxed !== null) {
    let node = relaxed.to;
    for (let i = 0; i < graph.nodes.length; i++) {
      node = pred.get(node)!.from;
    }
    const cycleEdges: Edge[] = [];
    let current = node;
    do {
      const edge = pred.get(current)!;
      cycleEdges.push(edge);
      current = edge.from;
    } while (current !== node);
    cycleEdges.reverse();
    return {
      kind: 'negative-cycle',
      certificate: {
        kind: 'negative-cycle',
        start: node,
        steps: cycleEdges.map((edge) => ({ edgeId: edge.id, edgeVersion: edge.version })),
      },
    };
  }
  return { kind: 'distances', dist, pred };
}

/**
 * Builds an optimality certificate (path + potentials) for source -> target.
 * Returns null when a negative cycle is reachable from source, when target is
 * unreachable, or when some node is unreachable (potentials must be finite
 * for every edge endpoint).
 */
export function generateOptimalityCertificate(
  graph: Graph,
  source: string,
  target: string,
): OptimalityCertificate | null {
  const result = shortestPaths(graph, source);
  if (result.kind !== 'distances') {
    return null;
  }
  const { dist, pred } = result;
  for (const node of graph.nodes) {
    if (!Number.isFinite(dist.get(node)!)) {
      return null;
    }
  }
  if (!graph.nodes.includes(target)) {
    return null;
  }
  const steps: { edgeId: string; edgeVersion: number }[] = [];
  let current = target;
  while (current !== source) {
    const edge = pred.get(current);
    if (edge === undefined) {
      return null;
    }
    steps.unshift({ edgeId: edge.id, edgeVersion: edge.version });
    current = edge.from;
  }
  const potentials: Record<string, number> = {};
  for (const node of graph.nodes) {
    potentials[node] = dist.get(node)!;
  }
  return {
    kind: 'optimality',
    source,
    target,
    path: { kind: 'path', start: source, steps, totalCost: dist.get(target)! },
    potentials,
  };
}

export function generateNegativeCycleCertificate(
  graph: Graph,
  source: string,
): NegativeCycleCertificate | null {
  const result = shortestPaths(graph, source);
  return result.kind === 'negative-cycle' ? result.certificate : null;
}

/** Builds a path certificate from explicit edge ids, summing costs from the graph. */
export function pathCertificateFromEdges(
  graph: Graph,
  start: string,
  edgeIds: readonly string[],
): PathCertificate {
  const byId = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const steps = edgeIds.map((id) => {
    const edge = byId.get(id);
    if (edge === undefined) {
      throw new Error(`no edge with id '${id}'`);
    }
    return { edgeId: edge.id, edgeVersion: edge.version };
  });
  const totalCost = edgeIds.reduce((sum, id) => sum + byId.get(id)!.cost, 0);
  return { kind: 'path', start, steps, totalCost };
}
