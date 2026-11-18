import {
  DependencyCycleError,
  UnknownDependencyError,
  type DependencyEdge,
  type DependencyReason,
  type SourceLocation,
} from "./errors.js";

export function templateId(name: string): string {
  return `template:${name}`;
}

export function helperId(name: string): string {
  return `helper:${name}`;
}

export interface DependencyReference {
  readonly target: string;
  readonly reason: DependencyReason;
  readonly location?: SourceLocation;
}

export interface DependencyResolution {
  readonly order: readonly string[];
  readonly edges: readonly DependencyEdge[];
}

/**
 * Returns a stable dependency-first order. The supplied node order is the
 * tie-breaker, which makes registration order deterministic.
 */
export function resolveDependencyOrder(
  nodeIds: readonly string[],
  adjacency: ReadonlyMap<string, readonly DependencyReference[]>,
): DependencyResolution {
  const nodes: string[] = [];
  const known = new Set<string>();
  for (const node of nodeIds) {
    if (known.has(node)) continue;
    known.add(node);
    nodes.push(node);
  }

  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackEdges: DependencyEdge[] = [];
  const order: string[] = [];
  const edges: DependencyEdge[] = [];

  const visit = (node: string): void => {
    color.set(node, 1);
    stack.push(node);

    for (const reference of adjacency.get(node) ?? []) {
      const edge: DependencyEdge = {
        from: node,
        to: reference.target,
        reason: reference.reason,
        ...(reference.location === undefined
          ? {}
          : { location: reference.location }),
      };
      edges.push(edge);

      if (!known.has(reference.target)) {
        throw new UnknownDependencyError(
          node,
          reference.target,
          reference.reason,
          reference.location,
        );
      }

      const targetColor = color.get(reference.target) ?? 0;
      if (targetColor === 1) {
        const cycleStart = stack.indexOf(reference.target);
        const cycle = stack.slice(cycleStart).concat(reference.target);
        const cycleEdges = stackEdges
          .slice(cycleStart)
          .concat(edge);
        throw new DependencyCycleError(cycle, cycleEdges);
      }

      if (targetColor === 0) {
        stackEdges.push(edge);
        visit(reference.target);
        stackEdges.pop();
      }
    }

    stack.pop();
    color.set(node, 2);
    order.push(node);
  };

  for (const node of nodes) {
    if ((color.get(node) ?? 0) === 0) visit(node);
  }

  return { order, edges };
}
