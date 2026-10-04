import type { Dag } from './types.js';

/**
 * Validates the DAG (all parents known, acyclic) and returns a
 * topological order with parents before children.
 */
export function topoOrder(dag: Dag): string[] {
  const nodeSet = new Set(dag.nodes);
  if (nodeSet.size !== dag.nodes.length) {
    throw new Error('duplicate node names in dag.nodes');
  }
  for (const node of dag.nodes) {
    for (const parent of dag.parents[node] ?? []) {
      if (!nodeSet.has(parent)) {
        throw new Error(`unknown parent "${parent}" of node "${node}"`);
      }
    }
  }

  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const node of dag.nodes) {
    indegree.set(node, 0);
    children.set(node, []);
  }
  for (const node of dag.nodes) {
    for (const parent of dag.parents[node] ?? []) {
      indegree.set(node, (indegree.get(node) ?? 0) + 1);
      children.get(parent)!.push(node);
    }
  }

  const queue = dag.nodes.filter((n) => indegree.get(n) === 0);
  const order: string[] = [];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head]!;
    order.push(node);
    for (const child of children.get(node)!) {
      const remaining = indegree.get(child)! - 1;
      indegree.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }
  if (order.length !== dag.nodes.length) {
    throw new Error('cycle detected in version DAG');
  }
  return order;
}
